import * as os from "node:os";
import type { AgentId } from "@wincode/agent-core";
import { agentIdSchema, toSubmissionId } from "@wincode/agent-core";
import {
	type ChatModelSelection,
	defaultChatModelSelection,
} from "@wincode/ai/models";
import { omitUndefined } from "@wincode/utils";
import { DEFAULT_AGENT_ID } from "@/modules/agents/built-ins";
import type { AgentRegistry } from "@/modules/agents/registry";
import {
	createApplicationPluginComposition,
	type OptionalApplicationPluginId,
} from "@/modules/application/plugin-composition";
import { loadPlugins } from "@/modules/plugins/loader";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import type {
	SessionSdk,
	SessionSdkChildFactory,
	SessionSdkCreateOptions,
	SessionSdkHandle,
	SessionSdkPrompt,
} from "./sdk-contract";

export type {
	SessionSdk,
	SessionSdkChildFactory,
	SessionSdkCreateOptions,
	SessionSdkDelivery,
	SessionSdkHandle,
	SessionSdkPrompt,
} from "./sdk-contract";

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

export type SessionSdkOptions = Omit<
	SessionCapabilitiesOptions,
	"cwd" | "pluginRuntime" | "sessionHostManager" | "getSessionSdk" | "workspace"
> &
	Readonly<{
		agent?: AgentId | string;
		cwd?: string;
		enabledPlugins?: readonly OptionalApplicationPluginId[];
		model?: ChatModelSelection;
		pluginPaths?: readonly string[];
		workspace?: string;
	}>;

type SessionSelectionDefaults = Readonly<{
	agent: AgentId;
	model: ChatModelSelection;
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
	options: Pick<SessionSdkOptions, "agent" | "model">
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
	if (input.effort !== undefined && input.reasoningMode !== undefined) {
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
		...(input.effort === undefined ? {} : { effort: input.effort }),
		...(input.reasoningMode === undefined
			? {}
			: { reasoningMode: input.reasoningMode }),
		...(input.effort === undefined ? {} : { sessionEffort: input.effort }),
		...(input.reasoningMode === undefined
			? {}
			: { sessionReasoningMode: input.reasoningMode }),
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
		const queued = snapshot.queuedSubmissions.find(
			(submission) => submission.submissionId === submissionId
		);
		if (queued !== undefined) {
			return {
				disposition: "queued",
				messageId: queued.messageId,
				rejected: false,
				submissionId,
			};
		}
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
	const deliver: SessionSdkHandle["deliver"] = (input) => {
		const previous = deliveries.get(input.idempotencyKey);
		if (previous !== undefined) {
			return previous;
		}
		const submissionId = deliverySubmissionId(input.idempotencyKey);
		const pending = (async () => {
			const existing = await existingDeliveryAdmission(submissionId);
			return existing ?? prompt({ text: input.text, submissionId });
		})();
		deliveries.set(input.idempotencyKey, pending);
		void pending.then((admission) => {
			if (admission.rejected) {
				deliveries.delete(input.idempotencyKey);
			}
		});
		return pending;
	};
	return Object.freeze({
		continue: () => host.agentSession.continue(),
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
	options: SessionSdkOptions,
	shared?: SharedSessionSdkResources
): Promise<SessionSdk> => {
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
	const composition = createApplicationPluginComposition({
		configStore,
		enabledPlugins: options.enabledPlugins ?? [],
		workspace,
	});
	const pluginRuntime: PluginRuntime = await loadPlugins({
		bundledPlugins: composition.bundledPlugins,
		cliPaths: options.pluginPaths ?? [],
		config: configRuntime,
		...(shared?.ignoreConfiguredPlugins === true
			? { ignoreConfiguredPlugins: true }
			: {}),
	});
	const {
		agent,
		cwd: _cwd,
		enabledPlugins = [],
		model,
		pluginPaths: _pluginPaths,
		workspace: _workspace,
		...capabilityOptions
	} = options;
	let sdk: SessionSdk | undefined;
	const assembly = await createSessionCapabilities({
		...capabilityOptions,
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
		...(composition.mcpResource === undefined
			? {}
			: { mcpResource: composition.mcpResource }),
		...(composition.createDelegationAdapter === undefined
			? {}
			: { createDelegationAdapter: composition.createDelegationAdapter }),
		...(composition.createDelegationRuntime === undefined
			? {}
			: { createDelegationRuntime: composition.createDelegationRuntime }),
		turnToolResolver: composition.turnToolResolver,
		workspace,
	});
	const handles = new Set<SessionSdkHandle>();
	const childSdks = new Set<SessionSdk>();
	let disposed = false;
	let disposePromise: Promise<void> | undefined;
	const defaultSelection = defaultsFor(assembly.capabilities.getRegistry(), {
		...(agent === undefined ? {} : { agent }),
		...(model === undefined ? {} : { model }),
	});
	const openSession = async (
		id: SessionId | string,
		openOptions: Readonly<{ view?: boolean }> = {},
		selection = defaultSelection
	): Promise<SessionSdkHandle> => {
		if (disposed) {
			throw new Error("Session SDK is disposed.");
		}
		const sessionId = toSessionId(id);
		const host = await assembly.capabilities.getSessionHostManager().openHost({
			capabilities: assembly.capabilities,
			sessionId,
			view: openOptions.view ?? true,
		});
		const stored = await assembly.store.getSession(sessionId);
		const prior = host.getSelection();
		const defaults = {
			agent: prior?.agent ?? selection.agent,
			model: prior?.model ?? stored.model ?? selection.model,
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
				model: createOptions?.model ?? model,
			})
		);
		const { id } = await assembly.store.createEmptySession(
			omitUndefined({
				id: createOptions?.sessionId,
				model: selection.model,
				effort: createOptions?.effort,
				reasoningMode: createOptions?.reasoningMode,
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
				model: createOptions?.model ?? model,
			})
		);
		const id = await createEmptySession({
			...createOptions,
			agent: selection.agent,
			model: selection.model,
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
		const childSdk = await createSessionSdkInternal(
			{
				...options,
				cwd,
				configRuntime,
				enabledPlugins: childOptions.enabledPlugins,
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
	const sdkApi: SessionSdk = Object.freeze({
		createChildSdk,
		createEmptySession,
		createSession,
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
	options: SessionSdkOptions = {}
): Promise<SessionSdk> => createSessionSdkInternal(options);

/** Creates explicitly selected child SDKs that share the owning Session Host. */
export const createSessionSdkChildFactory = (
	options: SessionSdkOptions,
	manager: SessionHostManager,
	store: SessionStore
): SessionSdkChildFactory => ({
	createChildSdk: (childOptions) =>
		createSessionSdkInternal(
			{
				...options,
				enabledPlugins: childOptions.enabledPlugins,
				pluginPaths: childOptions.pluginPaths ?? [],
				store,
			},
			{ ignoreConfiguredPlugins: true, manager, store }
		),
});
