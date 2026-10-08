import * as os from "node:os";
import type { AgentId, SubmissionId } from "@wincode/agent-core";
import { agentIdSchema, toSubmissionId } from "@wincode/agent-core";
import {
	type ChatModelSelection,
	defaultChatModelSelection,
	type Effort,
	type ReasoningMode,
} from "@wincode/ai/models";
import { omitUndefined } from "@wincode/utils";
import { DEFAULT_AGENT_ID } from "@/modules/agents/built-ins";
import type { AgentRegistry } from "@/modules/agents/registry";
import { createApplicationPluginComposition } from "@/modules/application/plugin-composition";
import { loadPlugins } from "@/modules/plugins/loader";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import type {
	SessionSdk,
	SessionSdkCapabilityCeiling,
	SessionSdkChildFactory,
	SessionSdkCreateOptions,
	SessionSdkHandle,
	SessionSdkPrompt,
} from "./sdk-contract";
import type { SessionSdkOptions as PublicSessionSdkOptions } from "./sdk-options";

export type * from "./sdk-contract";
export type { SessionSdkOptions } from "./sdk-options";

import type { SessionSubmissionAdmission } from "@/modules/sessions/agent-session/types";
import {
	createSessionCapabilities,
	type SessionCapabilitiesAssembly,
	type SessionCapabilitiesOptions,
} from "@/modules/sessions/host/session-capabilities";
import type {
	SessionHost,
	SessionHostManager,
} from "@/modules/sessions/host/types";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import type { SessionSendInput } from "@/modules/sessions/submission-types";
import type { ConfigRuntime } from "@/shared/config/config-store";
import { createConfigStore } from "@/shared/config/config-store";
import { type SessionId, toSessionId } from "@/shared/identifiers";

export type SessionSdkRuntimeOptions = Omit<
	SessionCapabilitiesOptions,
	"cwd" | "pluginRuntime" | "sessionHostManager" | "getSessionSdk" | "workspace"
> &
	Readonly<{
		agent?: AgentId | string;
		cwd?: string;
		effort?: Effort;
		model?: ChatModelSelection;
		reasoningMode?: ReasoningMode;
		pluginPaths?: readonly string[];
		workspace?: string;
	}>;

const snapshotCapabilityCeiling = (
	...ceilings: readonly (SessionSdkCapabilityCeiling | undefined)[]
): SessionSdkCapabilityCeiling | undefined => {
	const present = ceilings.filter(
		(ceiling): ceiling is SessionSdkCapabilityCeiling => ceiling !== undefined
	);
	if (present.length === 0) {
		return;
	}
	for (const ceiling of present) {
		if (
			!Array.isArray(ceiling.tools) ||
			ceiling.tools.some(
				(tool) => typeof tool !== "string" || tool.trim().length === 0
			)
		) {
			throw new Error(
				"Session capability ceilings require non-empty tool names."
			);
		}
	}
	const [first, ...rest] = present;
	const tools = new Set(first?.tools ?? []);
	for (const ceiling of rest) {
		for (const tool of tools) {
			if (!ceiling.tools.includes(tool)) {
				tools.delete(tool);
			}
		}
	}
	return Object.freeze({ tools: Object.freeze([...tools]) });
};

const optionsForChild = (
	options: SessionSdkRuntimeOptions,
	capabilityCeiling: SessionSdkCapabilityCeiling | undefined
): SessionSdkRuntimeOptions => {
	const {
		agent: _agent,
		capabilityCeiling: _parentCapabilityCeiling,
		effort: _effort,
		model: _model,
		reasoningMode: _reasoningMode,
		...sharedOptions
	} = options;
	return {
		...sharedOptions,
		...(capabilityCeiling === undefined ? {} : { capabilityCeiling }),
	};
};

type SessionSelectionDefaults = Readonly<{
	agent: AgentId;
	effort?: Effort;
	model: ChatModelSelection;
	reasoningMode?: ReasoningMode;
}>;

const parseAgent = (value: AgentId | string): AgentId => {
	const parsed = agentIdSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(`Invalid Agent Identifier: ${value}`);
	}
	return parsed.data;
};

const defaultsFor = (
	registry: AgentRegistry | null,
	options: Pick<
		SessionSdkRuntimeOptions,
		"agent" | "effort" | "model" | "reasoningMode"
	>
): SessionSelectionDefaults => {
	const agent =
		options.agent === undefined
			? (registry?.defaultAgentId ?? DEFAULT_AGENT_ID)
			: parseAgent(options.agent);
	const selectedAgent = registry?.agents.find(
		(candidate) => candidate.id === agent && candidate.isAvailable
	);
	return {
		agent,
		model: options.model ?? selectedAgent?.model ?? defaultChatModelSelection,
		...omitUndefined({
			effort: options.effort ?? selectedAgent?.effort,
			reasoningMode: options.reasoningMode ?? selectedAgent?.reasoningMode,
		}),
	};
};

const resolvedAgentFor = (
	registry: AgentRegistry | null,
	agent: AgentId
): SessionSendInput["resolvedAgent"] => {
	const candidate = registry?.agents.find(
		(item) => item.id === agent && item.isAvailable
	);
	if (registry !== null && candidate === undefined) {
		throw new Error(`Agent is unavailable: ${agent}`);
	}
	return candidate === undefined
		? undefined
		: {
				id: candidate.id,
				instructions: candidate.instructions,
				role: candidate.role,
				...(candidate.requiresManualApproval
					? { requiresManualApproval: true }
					: {}),
				visibleCodingTools: [...candidate.visibleCodingTools],
			};
};

const promptInputFor = (
	input: SessionSdkPrompt,
	defaults: SessionSelectionDefaults,
	registry: AgentRegistry | null
): SessionSendInput => {
	const hasExplicitReasoningSelection =
		input.effort !== undefined || input.reasoningMode !== undefined;
	const effort = hasExplicitReasoningSelection ? input.effort : defaults.effort;
	const reasoningMode = hasExplicitReasoningSelection
		? input.reasoningMode
		: defaults.reasoningMode;
	if (effort !== undefined && reasoningMode !== undefined) {
		throw new Error("Select either Effort or Reasoning Mode, not both.");
	}
	const agent =
		input.agent === undefined ? defaults.agent : parseAgent(input.agent);
	const model = input.model ?? defaults.model;
	return {
		agent,
		composition: { files: [], text: input.text },
		model,
		resolvedAgent: resolvedAgentFor(registry, agent),
		sessionModel: defaults.model,
		...omitUndefined({ effort, reasoningMode }),
		...omitUndefined({
			sessionEffort: effort,
			sessionReasoningMode: reasoningMode,
		}),
		...(input.submissionId === undefined
			? {}
			: { submissionId: input.submissionId }),
		userText: input.text,
	};
};

const deliveryTransactions = new WeakMap<
	SessionHost,
	Map<string, Promise<SessionSubmissionAdmission>>
>();

const handleFor = (
	assembly: SessionCapabilitiesAssembly,
	host: SessionHost,
	sessionId: SessionId,
	defaults: SessionSelectionDefaults
): SessionSdkHandle => {
	const { capabilities } = assembly;
	let disposed = false;
	let disposePromise: Promise<void> | undefined;
	const prompt: SessionSdkHandle["prompt"] = async (input) => {
		if (disposed) {
			return { reason: "Session handle is disposed.", rejected: true };
		}
		return host.agentSession.prompt(
			promptInputFor(input, defaults, capabilities.getRegistry())
		);
	};
	let deliveries = deliveryTransactions.get(host);
	if (deliveries === undefined) {
		deliveries = new Map();
		deliveryTransactions.set(host, deliveries);
	}
	const deliverySubmissionId = (idempotencyKey: string) => {
		if (idempotencyKey.length === 0 || idempotencyKey.length > 256) {
			throw new Error(
				"Session SDK delivery keys must contain 1–256 characters."
			);
		}
		const digest = new Bun.CryptoHasher("sha256")
			.update(idempotencyKey)
			.digest("hex");
		return toSubmissionId(`delivery-${digest}`);
	};
	const existingDeliveryAdmission = async (
		submissionId: SessionSdkPrompt["submissionId"]
	): Promise<SessionSubmissionAdmission | undefined> => {
		if (submissionId === undefined) {
			return;
		}
		const snapshot = host.getSnapshot();
		for (const message of snapshot.transcript) {
			if (message.metadata?.submissionId === submissionId) {
				return {
					disposition: "queued",
					messageId: message.id,
					rejected: false,
					submissionId,
				};
			}
		}
		const records = await assembly.store.listSessionRecords(sessionId);
		for (const record of records) {
			for (const message of record.messages) {
				if (message.metadata?.submissionId === submissionId) {
					return {
						disposition: "queued",
						messageId: message.id,
						rejected: false,
						submissionId,
					};
				}
			}
		}
		return;
	};
	const promptAndWaitForDurableDelivery = async (
		submissionId: SubmissionId,
		prompt: () => Promise<SessionSubmissionAdmission>
	): Promise<SessionSubmissionAdmission> => {
		const committed = Promise.withResolvers<SessionSubmissionAdmission>();
		let accepted:
			| Extract<SessionSubmissionAdmission, { readonly rejected: false }>
			| undefined;
		let failureReason: string | undefined;
		let settled = false;
		const settle = (): void => {
			if (accepted === undefined || settled) {
				return;
			}
			const message = host
				.getSnapshot()
				.transcript.find(
					(entry) => entry.metadata?.submissionId === submissionId
				);
			if (message !== undefined) {
				settled = true;
				committed.resolve({ ...accepted, messageId: message.id });
				return;
			}
			if (failureReason !== undefined) {
				settled = true;
				committed.resolve({ rejected: true, reason: failureReason });
			}
		};
		const unsubscribeSnapshot = host.subscribe(settle);
		const unsubscribeSubmission = host.agentSession.onSubmissionEvent(
			(event) => {
				if (event.submissionId !== submissionId) {
					return;
				}
				if (event.kind === "failed" || event.kind === "recalled") {
					failureReason =
						event.reason ?? "The Session message was not committed.";
				}
				settle();
			}
		);
		try {
			const admission = await prompt();
			if (admission.rejected) {
				return admission;
			}
			accepted = admission;
			settle();
			return await committed.promise;
		} finally {
			unsubscribeSnapshot();
			unsubscribeSubmission();
		}
	};
	const deliver: SessionSdkHandle["deliver"] = (input) => {
		const previous = deliveries.get(input.idempotencyKey);
		if (previous !== undefined) {
			return previous;
		}
		const submissionId = deliverySubmissionId(input.idempotencyKey);
		const pending = (async () => {
			const existing = await existingDeliveryAdmission(submissionId);
			if (existing !== undefined) {
				return existing;
			}
			if (disposed) {
				return {
					reason: "Session handle is disposed.",
					rejected: true as const,
				};
			}
			return promptAndWaitForDurableDelivery(submissionId, () =>
				host.agentSession.prompt({
					...promptInputFor(
						{ text: input.text, submissionId },
						defaults,
						capabilities.getRegistry()
					),
				})
			);
		})();
		deliveries.set(input.idempotencyKey, pending);
		void pending.then(
			(admission) => {
				if (admission.rejected) {
					deliveries.delete(input.idempotencyKey);
				}
			},
			() => deliveries.delete(input.idempotencyKey)
		);
		return pending;
	};
	return Object.freeze({
		continue: () => host.agentSession.continue(),
		interrupt: () => host.agentSession.interruptAll(),
		dispose: () => {
			if (disposePromise !== undefined) {
				return disposePromise;
			}
			disposed = true;
			const closing = capabilities
				.getSessionHostManager()
				.releaseView(sessionId);
			disposePromise = closing;
			return closing;
		},
		deliver,
		onEvent: host.onEvent,
		prompt,
		sessionId,
		subscribe: (listener) => {
			if (disposed) {
				return () => undefined;
			}
			listener(host.getSnapshot());
			return host.subscribe(() => listener(host.getSnapshot()));
		},
	});
};

type SharedSessionSdkResources = Readonly<{
	ignoreConfiguredPlugins: boolean;
	manager: SessionHostManager;
	store: SessionStore;
}>;

const createSessionSdkInternal = async (
	options: SessionSdkRuntimeOptions,
	shared?: SharedSessionSdkResources
): Promise<SessionSdk> => {
	const capabilityCeiling = snapshotCapabilityCeiling(
		options.capabilityCeiling
	);
	const workspace = options.workspace ?? process.cwd();
	const cwd = options.cwd ?? workspace;
	const configStore =
		options.configStore ??
		options.configRuntime?.configStore ??
		createConfigStore();
	const configRuntime: ConfigRuntime = options.configRuntime ?? {
		configStore,
		cwd,
		homeRoot: os.homedir(),
		workspace,
	};
	const composition = createApplicationPluginComposition();
	const pluginRuntime: PluginRuntime = await loadPlugins({
		cliPaths: options.pluginPaths ?? [],
		config: configRuntime,
		ignoreConfiguredPlugins: shared?.ignoreConfiguredPlugins ?? false,
	});
	const {
		agent,
		capabilityCeiling: _capabilityCeiling,
		cwd: _cwd,
		effort,
		model,
		pluginPaths: _pluginPaths,
		reasoningMode,
		workspace: _workspace,
		...capabilityOptions
	} = options;
	let sdk: SessionSdk | undefined;
	const assembly = await createSessionCapabilities({
		...capabilityOptions,
		...(capabilityCeiling === undefined ? {} : { capabilityCeiling }),
		configRuntime,
		cwd,
		pluginRuntime,
		getSessionSdk: () => sdk,
		...(shared === undefined
			? {}
			: {
					store: shared.store,
					sessionHostManager: shared.manager,
				}),
		turnToolResolver: composition.turnToolResolver,
		workspace,
	});
	const handles = new Set<SessionSdkHandle>();
	const childSdks = new Set<SessionSdk>();
	let disposed = false;
	let disposePromise: Promise<void> | undefined;
	const defaultSelection = defaultsFor(assembly.capabilities.getRegistry(), {
		...(agent === undefined ? {} : { agent }),
		...(effort === undefined ? {} : { effort }),
		...(model === undefined ? {} : { model }),
		...(reasoningMode === undefined ? {} : { reasoningMode }),
	});
	const openSession = async (
		id: SessionId | string,
		openOptions: Readonly<{ autoContinue?: boolean; view?: boolean }> = {},
		selection = defaultSelection
	): Promise<SessionSdkHandle> => {
		if (disposed) {
			throw new Error("Session SDK is disposed.");
		}
		const sessionId = toSessionId(id);
		const host = await assembly.capabilities.getSessionHostManager().openHost({
			autoContinue: openOptions.autoContinue ?? true,
			capabilities: assembly.capabilities,
			sessionId,
			view: openOptions.view ?? true,
		});
		const stored = await assembly.store.getSession(sessionId);
		const prior = host.getSelection();
		const defaults: SessionSelectionDefaults = {
			agent: prior?.agent ?? selection.agent,
			model: prior?.model ?? stored.model ?? selection.model,
			...omitUndefined({
				effort: prior?.effort ?? stored.effort ?? selection.effort,
				reasoningMode:
					prior?.reasoningMode ??
					stored.reasoningMode ??
					selection.reasoningMode,
			}),
		};
		const handle = handleFor(assembly, host, sessionId, defaults);
		handles.add(handle);
		return handle;
	};
	const createEmptySession: SessionSdk["createEmptySession"] = async (
		createOptions
	) => {
		if (disposed) {
			throw new Error("Session SDK is disposed.");
		}
		const selection = defaultsFor(
			assembly.capabilities.getRegistry(),
			omitUndefined({
				agent: createOptions?.agent ?? agent,
				effort: createOptions?.effort ?? effort,
				model: createOptions?.model ?? model,
				reasoningMode: createOptions?.reasoningMode ?? reasoningMode,
			})
		);
		const { id } = await assembly.store.createEmptySession(
			omitUndefined({
				id: createOptions?.sessionId,
				model: selection.model,
				effort: selection.effort,
				reasoningMode: selection.reasoningMode,
			})
		);
		return id;
	};
	const createSession = async (
		createOptions?: SessionSdkCreateOptions
	): Promise<SessionSdkHandle> => {
		if (disposed) {
			throw new Error("Session SDK is disposed.");
		}
		const selection = defaultsFor(
			assembly.capabilities.getRegistry(),
			omitUndefined({
				agent: createOptions?.agent ?? agent,
				effort: createOptions?.effort ?? effort,
				model: createOptions?.model ?? model,
				reasoningMode: createOptions?.reasoningMode ?? reasoningMode,
			})
		);
		const id = await createEmptySession({
			...createOptions,
			agent: selection.agent,
			model: selection.model,
			effort: createOptions?.effort ?? selection.effort,
			reasoningMode: createOptions?.reasoningMode ?? selection.reasoningMode,
		});
		const handle = await openSession(id, {}, selection);
		if (createOptions?.initialPrompt !== undefined) {
			const admission = await handle.prompt({
				text: createOptions.initialPrompt,
				...omitUndefined({
					agent: createOptions.agent,
					effort: createOptions.effort,
					model: createOptions.model,
					reasoningMode: createOptions.reasoningMode,
				}),
			});
			if (admission.rejected) {
				await handle.dispose();
				throw new Error(admission.reason);
			}
		}
		return handle;
	};
	const createChildSdk: SessionSdk["createChildSdk"] = async (
		childOptions
	): Promise<SessionSdk> => {
		if (disposed) {
			throw new Error("Session SDK is disposed.");
		}
		const childCapabilityCeiling = snapshotCapabilityCeiling(
			capabilityCeiling,
			childOptions.capabilityCeiling
		);
		const childSdk = await createSessionSdkInternal(
			{
				...optionsForChild(options, childCapabilityCeiling),
				cwd,
				configRuntime,
				pluginPaths: childOptions.pluginPaths ?? [],
				store: assembly.store,
				workspace,
			},
			{
				ignoreConfiguredPlugins: true,
				manager: assembly.capabilities.getSessionHostManager(),
				store: assembly.store,
			}
		);
		childSdks.add(childSdk);
		return childSdk;
	};
	const getAgentCatalog: SessionSdk["getAgentCatalog"] = async () =>
		Object.freeze(
			(assembly.capabilities.getRegistry()?.agents ?? []).map(
				({ id, isAvailable, role }) => ({ id, isAvailable, role })
			)
		);
	const sdkApi: SessionSdk = Object.freeze({
		createChildSdk,
		createEmptySession,
		getAgentCatalog,
		createSession,
		deliverToSession: async (sessionId, input) => {
			const handle = await openSession(sessionId, { view: true });
			try {
				return await handle.deliver(input);
			} finally {
				await handle.dispose();
			}
		},
		dispose: () => {
			if (disposePromise !== undefined) {
				return disposePromise;
			}
			disposed = true;
			const closing = (async () => {
				await Promise.allSettled(
					[...handles].map((handle) => handle.dispose())
				);
				await Promise.allSettled(
					[...childSdks].map((childSdk) => childSdk.dispose())
				);
				await assembly.shutdown();
			})();
			disposePromise = closing;
			return closing;
		},
		openSession,
	});
	sdk = sdkApi;
	return sdkApi;
};

/** Creates a public, caller-owned Session SDK over the Coding-Agent Host. */
export const createSessionSdk = (
	options: PublicSessionSdkOptions = {}
): Promise<SessionSdk> => createSessionSdkInternal(options);

/** Creates an SDK with internal host dependencies for in-process callers. */
export const createSessionSdkWithRuntime = (
	options: SessionSdkRuntimeOptions
): Promise<SessionSdk> => createSessionSdkInternal(options);

/** Creates explicitly selected child SDKs that share the owning Session Host. */
export const createSessionSdkChildFactory = (
	options: SessionSdkRuntimeOptions,
	manager: SessionHostManager,
	store: SessionStore
): SessionSdkChildFactory => {
	const runtimeOptions = options;
	const capabilityCeiling = snapshotCapabilityCeiling(
		runtimeOptions.capabilityCeiling
	);
	const withChildSdk = async <Result>(
		operation: (sdk: SessionSdk) => Promise<Result>
	): Promise<Result> => {
		const sdk = await createSessionSdkInternal(
			{ ...optionsForChild(runtimeOptions, capabilityCeiling), store },
			{ ignoreConfiguredPlugins: true, manager, store }
		);
		try {
			return await operation(sdk);
		} finally {
			await sdk.dispose();
		}
	};
	return {
		createChildSdk: (childOptions) => {
			const childCapabilityCeiling = snapshotCapabilityCeiling(
				capabilityCeiling,
				childOptions.capabilityCeiling
			);
			return createSessionSdkInternal(
				{
					...optionsForChild(runtimeOptions, childCapabilityCeiling),
					pluginPaths: childOptions.pluginPaths ?? [],
					store,
				},
				{ ignoreConfiguredPlugins: true, manager, store }
			);
		},
		createEmptySession: (createOptions) =>
			withChildSdk((sdk) => sdk.createEmptySession(createOptions)),
		getAgentCatalog: () => withChildSdk((sdk) => sdk.getAgentCatalog()),
		deliverToSession: (sessionId, input) =>
			withChildSdk((sdk) => sdk.deliverToSession(sessionId, input)),
		openSession: async (sessionId, openOptions) => {
			const sdk = await createSessionSdkInternal(
				{ ...optionsForChild(runtimeOptions, capabilityCeiling), store },
				{ ignoreConfiguredPlugins: true, manager, store }
			);
			try {
				const handle = await sdk.openSession(sessionId, openOptions);
				let disposePromise: Promise<void> | undefined;
				return Object.freeze({
					continue: handle.continue,
					deliver: handle.deliver,
					dispose: () => {
						if (disposePromise !== undefined) {
							return disposePromise;
						}
						disposePromise = (async () => {
							await handle.dispose();
							await sdk.dispose();
						})();
						return disposePromise;
					},
					interrupt: handle.interrupt,
					onEvent: handle.onEvent,
					prompt: handle.prompt,
					sessionId: handle.sessionId,
					subscribe: handle.subscribe,
				});
			} catch (error) {
				await sdk.dispose();
				throw error;
			}
		},
	};
};
