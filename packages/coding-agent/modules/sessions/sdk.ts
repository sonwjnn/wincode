import * as os from "node:os";
import * as path from "node:path";
import type { AgentId, SubmissionId } from "@wincode/agent-core";
import { toSubmissionId } from "@wincode/agent-core";
import type { ThinkingLevel } from "@wincode/ai/models";
import type { ProviderModel } from "@wincode/ai/sdk";
import { omitUndefined } from "@wincode/utils";
import {
	resolveEffectiveAgentSelection,
	withAvailableAgentModelOverride,
} from "@/modules/agents/agent-call";
import {
	type AgentRegistry,
	applyCapabilityCeilingToAgentRegistry,
	canDeferAgentModelAvailability,
} from "@/modules/agents/registry";
import { loadPlugins, pluginSourceIdentity } from "@/modules/plugins/loader";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import {
	isTrustedProjectPluginSource,
	resolveProjectTrust,
} from "@/modules/project-trust/project-trust";
import {
	catalogSelectionForProviderModel,
	isAvailableProviderModelSelection,
	type ProviderModelSelection,
} from "@/modules/providers/provider-model-selection";
import type { SessionSdkPluginProviderSource } from "./plugin-provider-source";
import {
	type SessionSdk,
	type SessionSdkCapabilityCeiling,
	type SessionSdkCreateOptions,
	type SessionSdkHandle,
	type SessionSdkOperations,
	type SessionSdkPrompt,
	snapshotSessionSdkCapabilityCeiling,
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
import { createDefaultSessionProviderCollection } from "@/modules/sessions/provider-collection";
import {
	resolveRestoredSessionSdkSelection,
	resolveSessionSdkPromptSelection,
	resolveSessionSdkSelectionDefaults,
	type SessionSdkSelectionDefaults,
} from "@/modules/sessions/selection";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import type { SessionSendInput } from "@/modules/sessions/submission-types";
import type { ConfigRuntime, ConfigStore } from "@/shared/config/config-store";
import { createConfigStore } from "@/shared/config/config-store";
import { type SessionId, toSessionId } from "@/shared/identifiers";
import { resolveUserWincodeDir } from "@/shared/paths/user-data-dir";

export type SessionSdkRuntimeOptions = Omit<
	SessionCapabilitiesOptions,
	| "getConfig"
	| "getPluginRuntime"
	| "plugin"
	| "sessionHostManager"
	| "getSessionSdk"
	| "workspace"
> &
	Readonly<{
		agent?: AgentId | string;
		/** The configuration this SDK loads Plugins and resolves trust with. */
		configRuntime?: ConfigRuntime;
		/** The configuration store this SDK builds its configuration runtime from. */
		configStore?: ConfigStore;
		cwd?: string;
		model?: ProviderModelSelection;
		thinkingLevel?: ThinkingLevel;
		getPluginProviderSources?: (
			providerIds: readonly string[]
		) => readonly SessionSdkPluginProviderSource[];
		pluginPaths?: readonly string[];
		pluginProviderSources?: readonly SessionSdkPluginProviderSource[];
		projectTrust?: "trust" | "deny";
		workspace?: string;
	}>;

const snapshotCapabilityCeiling = (
	...ceilings: readonly (SessionSdkCapabilityCeiling | undefined)[]
): SessionSdkCapabilityCeiling | undefined => {
	const present = ceilings
		.map(snapshotSessionSdkCapabilityCeiling)
		.filter(
			(ceiling): ceiling is SessionSdkCapabilityCeiling => ceiling !== undefined
		);
	if (present.length === 0) {
		return;
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
	return snapshotSessionSdkCapabilityCeiling({ tools: [...tools] });
};

const optionsForSessionRuntime = (
	options: SessionSdkRuntimeOptions,
	capabilityCeiling: SessionSdkCapabilityCeiling | undefined
): SessionSdkRuntimeOptions => {
	const {
		agent: _agent,
		capabilityCeiling: _parentCapabilityCeiling,
		configRuntime: _configRuntime,
		configStore: _configStore,
		getPluginProviderSources: _getPluginProviderSources,
		model: _model,
		pluginProviderSources: _pluginProviderSources,
		runtimeFactory: _runtimeFactory,
		projectTrust: _projectTrust,
		thinkingLevel: _thinkingLevel,
		...sharedOptions
	} = options;
	return {
		...sharedOptions,
		...(capabilityCeiling === undefined ? {} : { capabilityCeiling }),
	};
};

const pluginProviderIdsForSources = (
	allowedProviderIds: readonly string[] | undefined,
	selectedSources: readonly SessionSdkPluginProviderSource[]
): readonly string[] => {
	const selectedIds = new Set(
		selectedSources.map(({ providerId }) => providerId)
	);
	return allowedProviderIds === undefined || allowedProviderIds.length === 0
		? [...selectedIds]
		: allowedProviderIds.filter((providerId) => selectedIds.has(providerId));
};

const loadSessionSdkPluginRuntime = async ({
	configRuntime,
	ignoreConfiguredPlugins,
	pluginPaths,
	selectedSources,
	projectTrust,
}: Readonly<{
	configRuntime: ConfigRuntime;
	ignoreConfiguredPlugins: boolean;
	pluginPaths: readonly string[];
	projectTrust: "trust" | "deny" | undefined;
	selectedSources: readonly SessionSdkPluginProviderSource[] | undefined;
}>): Promise<PluginRuntime> => {
	const sources = selectedSources ?? [];
	const explicitSources = pluginPaths.map((sourcePath) => {
		const resolvedSourcePath = path.resolve(
			configRuntime.workspace,
			sourcePath
		);
		return {
			sourceIdentity: pluginSourceIdentity(resolvedSourcePath),
			sourcePath: resolvedSourcePath,
		};
	});
	for (const source of explicitSources) {
		if (
			!(await isTrustedProjectPluginSource({
				allowUnscopedExternal: true,
				override: projectTrust,
				projectTrustDir: resolveUserWincodeDir(),
				sourceIdentity: source.sourceIdentity,
				sourcePath: source.sourcePath,
				workspace: configRuntime.workspace,
			}))
		) {
			throw new Error(
				`Explicit Plugin source '${source.sourcePath}' is not trusted in the child Session.`
			);
		}
	}
	for (const source of sources) {
		if (
			source.sourcePath.startsWith("factory:") ||
			pluginSourceIdentity(source.sourcePath) !== source.sourceIdentity
		) {
			throw new Error(
				`Selected Plugin Provider '${source.providerId}' from Plugin '${source.pluginId}' has changed source identity. Re-select it in Interactive Mode.`
			);
		}
		if (
			!(await isTrustedProjectPluginSource({
				allowUnscopedExternal: source.sourceScope !== "project",
				override: projectTrust,
				projectTrustDir: resolveUserWincodeDir(),
				sourceIdentity: source.sourceIdentity,
				sourcePath: source.sourcePath,
				workspace: configRuntime.workspace,
			}))
		) {
			throw new Error(
				`Selected Plugin Provider '${source.providerId}' from Plugin '${source.pluginId}' is not trusted in the child Session.`
			);
		}
	}
	const runtime = await loadPlugins({
		cliPaths: [
			...new Set([
				...explicitSources.map(({ sourceIdentity }) => sourceIdentity),
				...sources.map(({ sourceIdentity }) => sourceIdentity),
			]),
		],
		config: configRuntime,
		ignoreConfiguredPlugins,
	});
	for (const source of sources) {
		const sourceIsRegistered = runtime
			.getProviderRegistrations()
			.some(
				(provider) =>
					provider.providerId === source.providerId &&
					provider.pluginId === source.pluginId &&
					provider.sourceIdentity === source.sourceIdentity
			);
		if (!sourceIsRegistered) {
			await runtime.shutdown();
			throw new Error(
				`Selected Plugin Provider '${source.providerId}' from Plugin '${source.pluginId}' could not be verified in the child Session. Re-select it in Interactive Mode.`
			);
		}
	}
	return runtime;
};

const createProviderCollectionFactoryForPluginSources = (
	inheritedFactory: SessionCapabilitiesOptions["createProviderCollection"],
	selectedSources: readonly SessionSdkPluginProviderSource[] | undefined
): SessionCapabilitiesOptions["createProviderCollection"] => {
	if (selectedSources === undefined) {
		return inheritedFactory;
	}
	if (inheritedFactory === undefined) {
		return (
			pluginProviderRuntime,
			sessionId,
			allowedPluginProviderIds,
			allowedPluginProviderSources
		) =>
			createDefaultSessionProviderCollection(pluginProviderRuntime, sessionId, {
				allowedPluginProviderSources: allowedPluginProviderSources ?? [],
				allowedPluginProviderIds: pluginProviderIdsForSources(
					allowedPluginProviderIds,
					allowedPluginProviderSources ?? []
				),
			});
	}
	return (pluginProviderRuntime, sessionId, allowedPluginProviderIds) =>
		inheritedFactory(
			pluginProviderRuntime,
			sessionId,
			pluginProviderIdsForSources(allowedPluginProviderIds, selectedSources),
			selectedSources
		);
};

const isAgentModelAvailabilityDeferred = (
	agent: AgentRegistry["agents"][number]
): boolean => canDeferAgentModelAvailability(agent);

const promptInputFor = async (
	input: SessionSdkPrompt,
	defaults: SessionSdkSelectionDefaults,
	registry: AgentRegistry | null,
	host: SessionHost
): Promise<SessionSendInput> => {
	const selection = resolveSessionSdkPromptSelection(input, defaults);
	const availableProviderModels: readonly ProviderModel[] | undefined =
		host.providerCollection === undefined
			? undefined
			: await host.providerCollection.getAvailable();
	const pinnedAgentModel = registry?.agents.find(
		(candidate) => candidate.id === selection.agent
	)?.model;
	const hasExplicitModelReplacement =
		input.model !== undefined ||
		(pinnedAgentModel !== undefined &&
			(pinnedAgentModel.providerId !== selection.model.providerId ||
				pinnedAgentModel.modelId !== selection.model.modelId));
	const usesPinnedAgentModel =
		pinnedAgentModel !== undefined &&
		pinnedAgentModel.providerId === selection.model.providerId &&
		pinnedAgentModel.modelId === selection.model.modelId;
	if (
		usesPinnedAgentModel &&
		catalogSelectionForProviderModel(pinnedAgentModel) === null &&
		availableProviderModels !== undefined &&
		!isAvailableProviderModelSelection(
			pinnedAgentModel,
			availableProviderModels
		)
	) {
		throw new Error(
			`Provider Model ${pinnedAgentModel.providerId}/${pinnedAgentModel.modelId} is unavailable in this Session Host.`
		);
	}
	const explicitSelectionOverride = hasExplicitModelReplacement
		? { model: selection.model }
		: undefined;
	const selectionOverride = withAvailableAgentModelOverride(
		registry,
		selection.agent,
		explicitSelectionOverride,
		availableProviderModels
	);
	const effective = resolveEffectiveAgentSelection(
		registry,
		selection.agent,
		selection.model,
		selection,
		false,
		selectionOverride,
		{ allowModelAvailabilityDeferral: availableProviderModels !== undefined }
	);
	if (effective.unavailableReason !== undefined) {
		throw new Error(effective.unavailableReason);
	}
	if (
		availableProviderModels !== undefined &&
		!isAvailableProviderModelSelection(effective.model, availableProviderModels)
	) {
		throw new Error(
			`Provider Model ${effective.model.providerId}/${effective.model.modelId} is unavailable in this Session Host.`
		);
	}
	return {
		agent: effective.agent,
		composition: { files: [], text: input.text },
		model: effective.model,
		resolvedAgent: effective.resolvedAgent,
		...omitUndefined({ selectionOverride }),
		sessionModel: defaults.model,
		...omitUndefined({ thinkingLevel: effective.thinkingLevel }),
		...omitUndefined({ sessionThinkingLevel: selection.thinkingLevel }),
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
	defaults: SessionSdkSelectionDefaults
): SessionSdkHandle => {
	const { capabilities } = assembly;
	let disposed = false;
	let disposePromise: Promise<void> | undefined;
	const prompt: SessionSdkHandle["prompt"] = async (input) => {
		if (disposed) {
			return { reason: "Session handle is disposed.", rejected: true };
		}
		return host.agentSession.prompt(
			await promptInputFor(input, defaults, capabilities.getRegistry(), host)
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
			return promptAndWaitForDurableDelivery(submissionId, async () =>
				host.agentSession.prompt(
					await promptInputFor(
						{ text: input.text, submissionId },
						defaults,
						capabilities.getRegistry(),
						host
					)
				)
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
	const trustResolution =
		options.projectTrust === undefined &&
		options.configRuntime?.trustedProjectRoots !== undefined
			? {
					trustedProjectRoots: options.configRuntime.trustedProjectRoots,
				}
			: await resolveProjectTrust({
					mode: "sdk",
					override: options.projectTrust,
					projectTrustDir: resolveUserWincodeDir(),
					workspace,
				});
	const trustedProjectRoots = trustResolution.trustedProjectRoots;
	const configStore =
		options.configStore ??
		options.configRuntime?.configStore ??
		createConfigStore({ trustedProjectRoots });
	const configRuntime: ConfigRuntime =
		options.configRuntime === undefined
			? {
					configStore,
					cwd,
					homeRoot: os.homedir(),
					trustedProjectRoots,
					workspace,
				}
			: {
					...options.configRuntime,
					trustedProjectRoots,
				};
	const inheritedPluginProviderSources = options.pluginProviderSources;
	const pluginRuntime = await loadSessionSdkPluginRuntime({
		configRuntime,
		ignoreConfiguredPlugins: shared?.ignoreConfiguredPlugins ?? false,
		pluginPaths: options.pluginPaths ?? [],
		projectTrust: options.projectTrust,
		selectedSources: inheritedPluginProviderSources,
	});
	const {
		agent,
		capabilityCeiling: _capabilityCeiling,
		configRuntime: _configRuntime,
		configStore: _configStore,
		createProviderCollection: inheritedProviderCollectionFactory,
		cwd: _cwd,
		getPluginProviderSources: _getPluginProviderSources,
		model,
		pluginPaths: _pluginPaths,
		pluginProviderSources: _pluginProviderSources,
		thinkingLevel,
		workspace: _workspace,
		...capabilityOptions
	} = options;
	const createProviderCollection =
		createProviderCollectionFactoryForPluginSources(
			inheritedProviderCollectionFactory,
			inheritedPluginProviderSources
		);
	let sdk: SessionSdk | undefined;
	const assembly = await createSessionCapabilities({
		...capabilityOptions,
		...(createProviderCollection === undefined
			? {}
			: { createProviderCollection }),
		...(capabilityCeiling === undefined ? {} : { capabilityCeiling }),
		getConfig: () => configRuntime,
		plugin: { ownedByCaller: true, runtime: pluginRuntime },
		getSessionSdk: () => sdk,
		...(shared === undefined
			? {}
			: {
					store: shared.store,
					sessionHostManager: shared.manager,
				}),
		workspace,
	});
	const handles = new Set<SessionSdkHandle>();
	const sessionRuntimes = new Set<SessionSdk>();
	let disposed = false;
	let disposePromise: Promise<void> | undefined;
	const defaultSelection = resolveSessionSdkSelectionDefaults(
		assembly.capabilities.getRegistry(),
		{
			...(agent === undefined ? {} : { agent }),
			...(model === undefined ? {} : { model }),
			...(thinkingLevel === undefined ? {} : { thinkingLevel }),
		}
	);
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
		const defaults = resolveRestoredSessionSdkSelection(
			selection,
			stored,
			prior
		);
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
		const selection = resolveSessionSdkSelectionDefaults(
			assembly.capabilities.getRegistry(),
			omitUndefined({
				agent: createOptions?.agent ?? agent,
				model: createOptions?.model ?? model,
				thinkingLevel: createOptions?.thinkingLevel ?? thinkingLevel,
			})
		);
		const { id } = await assembly.store.createEmptySession(
			omitUndefined({
				id: createOptions?.sessionId,
				model: selection.model,
				thinkingLevel: selection.thinkingLevel,
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
		const selection = resolveSessionSdkSelectionDefaults(
			assembly.capabilities.getRegistry(),
			omitUndefined({
				agent: createOptions?.agent ?? agent,
				model: createOptions?.model ?? model,
				thinkingLevel: createOptions?.thinkingLevel ?? thinkingLevel,
			})
		);
		const id = await createEmptySession({
			...createOptions,
			agent: selection.agent,
			model: selection.model,
			thinkingLevel: createOptions?.thinkingLevel ?? selection.thinkingLevel,
		});
		const handle = await openSession(id, {}, selection);
		if (createOptions?.initialPrompt !== undefined) {
			const admission = await handle.prompt({
				text: createOptions.initialPrompt,
				...omitUndefined({
					agent: createOptions.agent,
					model: createOptions.model,
					thinkingLevel: createOptions.thinkingLevel,
				}),
			});
			if (admission.rejected) {
				await handle.dispose();
				throw new Error(admission.reason);
			}
		}
		return handle;
	};
	const createSessionRuntime: SessionSdk["createSessionRuntime"] = async (
		runtimeOptions = {}
	): Promise<SessionSdk> => {
		if (disposed) {
			throw new Error("Session SDK is disposed.");
		}
		const runtimeCapabilityCeiling = snapshotCapabilityCeiling(
			capabilityCeiling,
			runtimeOptions.capabilityCeiling
		);
		const selectedProviderIds = new Set(runtimeOptions.pluginProviderIds ?? []);
		if (runtimeOptions.sessionId !== undefined) {
			const storedSession = await assembly.store.getSession(
				toSessionId(runtimeOptions.sessionId)
			);
			if (storedSession.model !== undefined) {
				selectedProviderIds.add(storedSession.model.providerId);
			}
		}
		const requestedProviderIds = [...selectedProviderIds];
		const availableProviderSources =
			_getPluginProviderSources?.(requestedProviderIds) ??
			pluginRuntime
				.getProviderRegistrations()
				.filter((provider) =>
					requestedProviderIds.includes(provider.providerId)
				)
				.map((provider) => {
					const inheritedSource = inheritedPluginProviderSources?.find(
						(source) =>
							source.pluginId === provider.pluginId &&
							source.providerId === provider.providerId &&
							source.sourceIdentity === provider.sourceIdentity
					);
					const sourceScope =
						inheritedSource?.sourceScope ?? provider.sourceScope;
					return {
						pluginId: provider.pluginId,
						providerId: provider.providerId,
						sourceIdentity: provider.sourceIdentity,
						sourcePath: inheritedSource?.sourcePath ?? provider.sourcePath,
						...(sourceScope === undefined ? {} : { sourceScope }),
					};
				});
		const selectedPluginProviderSources = requestedProviderIds.flatMap(
			(providerId) => {
				const matchingSources = availableProviderSources.filter(
					(source) => source.providerId === providerId
				);
				if (matchingSources.length > 1) {
					throw new Error(
						`Provider ID '${providerId}' is registered by multiple Plugins; the child Session cannot select it safely.`
					);
				}
				return matchingSources;
			}
		);
		const runtimeSdk = await createSessionSdkInternal(
			{
				...optionsForSessionRuntime(options, runtimeCapabilityCeiling),
				cwd,
				pluginPaths: runtimeOptions.pluginPaths ?? [],
				pluginProviderSources: selectedPluginProviderSources,
				...(runtimeOptions.projectTrust === undefined
					? {}
					: { projectTrust: runtimeOptions.projectTrust }),
				store: assembly.store,
				workspace,
			},
			{
				ignoreConfiguredPlugins: true,
				manager: assembly.capabilities.getSessionHostManager(),
				store: assembly.store,
			}
		);
		sessionRuntimes.add(runtimeSdk);
		return runtimeSdk;
	};
	const getAgentCatalog: SessionSdk["getAgentCatalog"] = async (
		catalogOptions
	) => {
		const catalogRegistry = applyCapabilityCeilingToAgentRegistry(
			assembly.capabilities.getRegistry(),
			snapshotCapabilityCeiling(
				capabilityCeiling,
				catalogOptions?.capabilityCeiling
			)
		);
		return Object.freeze(
			(catalogRegistry?.agents ?? []).map((agent) => {
				const sdkModelAvailabilityDeferred =
					isAgentModelAvailabilityDeferred(agent);
				return {
					description: agent.description,
					id: agent.id,
					isAvailable: agent.isAvailable || sdkModelAvailabilityDeferred,
					...(agent.model === undefined ? {} : { model: agent.model }),
					...(agent.thinkingLevel === undefined
						? {}
						: { thinkingLevel: agent.thinkingLevel }),
					role: agent.role,
					...(agent.source === undefined ? {} : { source: agent.source.scope }),
					...(agent.requiredTools === undefined
						? {}
						: { requiredTools: agent.requiredTools }),
					...(agent.unavailableReason === undefined ||
					sdkModelAvailabilityDeferred
						? {}
						: { unavailableReason: agent.unavailableReason }),
				};
			})
		);
	};
	const sdkApi: SessionSdk = Object.freeze({
		createSessionRuntime,
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
					[...sessionRuntimes].map((sessionRuntime) => sessionRuntime.dispose())
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

/** Creates generic Session SDK operations backed by an existing Session Host. */
export const createSessionSdkOperations = (
	options: SessionSdkRuntimeOptions,
	manager: SessionHostManager,
	store: SessionStore
): SessionSdkOperations => {
	const hostRuntimeOptions = options;
	const capabilityCeiling = snapshotCapabilityCeiling(
		hostRuntimeOptions.capabilityCeiling
	);
	const createSessionRuntime: SessionSdkOperations["createSessionRuntime"] = (
		runtimeOptions = {}
	) => {
		const runtimeCapabilityCeiling = snapshotCapabilityCeiling(
			capabilityCeiling,
			runtimeOptions.capabilityCeiling
		);
		return createSessionSdkInternal(
			{
				...optionsForSessionRuntime(
					hostRuntimeOptions,
					runtimeCapabilityCeiling
				),
				pluginPaths: runtimeOptions.pluginPaths ?? [],
				store,
				...(runtimeOptions.projectTrust === undefined
					? {}
					: { projectTrust: runtimeOptions.projectTrust }),
			},
			{ ignoreConfiguredPlugins: true, manager, store }
		);
	};
	const withSessionRuntime = async <Result>(
		operation: (sdk: SessionSdk) => Promise<Result>
	): Promise<Result> => {
		const sdk = await createSessionRuntime();
		try {
			return await operation(sdk);
		} finally {
			await sdk.dispose();
		}
	};
	return {
		createSessionRuntime,
		createEmptySession: (createOptions) =>
			withSessionRuntime((sdk) => sdk.createEmptySession(createOptions)),
		getAgentCatalog: (catalogOptions) =>
			withSessionRuntime((sdk) => sdk.getAgentCatalog(catalogOptions)),
		deliverToSession: (sessionId, input) =>
			withSessionRuntime((sdk) => sdk.deliverToSession(sessionId, input)),
		openSession: async (sessionId, openOptions) => {
			const sdk = await createSessionRuntime();
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
