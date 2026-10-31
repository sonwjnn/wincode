import * as os from "node:os";
import * as path from "node:path";
import type { AgentId, SubmissionId } from "@wincode/agent-core";
import {
	toAgentTurnId,
	toSessionMessageId,
	toSubmissionId,
} from "@wincode/agent-core";
import type {
	ProviderCollection,
	ProviderModel,
	ThinkingLevel,
} from "@wincode/ai";
import { omitUndefined } from "@wincode/utils";
import { randomUUIDv7 } from "bun";
import {
	resolveEffectiveAgentSelection,
	withAvailableAgentModelOverride,
} from "@/modules/agents/agent-call";
import {
	type AgentRegistry,
	applyCapabilityCeilingToAgentRegistry,
} from "@/modules/agents/registry";
import { loadPlugins, pluginSourceIdentity } from "@/modules/plugins/loader";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import {
	isTrustedProjectPluginSource,
	resolveProjectTrust,
} from "@/modules/project-trust/project-trust";
import { isBuiltInProviderId } from "@/modules/providers/built-in-provider-catalog";
import {
	isAvailableProviderModelSelection,
	isPluginProviderSelectionBoundToTrustedOwner,
	isSameProviderModelIdentity,
	type ProviderModelSelection,
	ProviderModelSelectionOwnershipError,
	pluginProviderIdentityMatches,
	pluginProviderOwnerMatches,
	resolveProviderModelSelectionForHost,
} from "@/modules/providers/provider-model-selection";
import type { SessionSdkPluginProviderSource } from "./plugin-provider-source";
import {
	type SessionRuntimeOptions,
	type SessionSdk,
	type SessionSdkCapabilityCeiling,
	type SessionSdkCreateOptions,
	type SessionSdkHandle,
	type SessionSdkOperations,
	type SessionSdkPluginFactory,
	type SessionSdkPrompt,
	type SessionSdkSnapshot,
	snapshotSessionSdkCapabilityCeiling,
} from "./sdk-contract";
import type { SessionSdkOptions as PublicSessionSdkOptions } from "./sdk-options";

export type * from "./sdk-contract";
export type { SessionSdkOptions } from "./sdk-options";

import type {
	LiveSessionSnapshot,
	SessionSubmissionAdmission,
} from "@/modules/sessions/agent-session/types";
import { createValidatedPluginProviderCollectionForSelection } from "@/modules/sessions/host/agent-session-turn-runner";
import {
	createSessionCapabilities,
	type SessionCapabilitiesAssembly,
	type SessionCapabilitiesOptions,
} from "@/modules/sessions/host/session-capabilities";
import type {
	SessionHost,
	SessionHostManager,
} from "@/modules/sessions/host/types";
import { createSessionUserMessage } from "@/modules/sessions/message";
import {
	createDefaultSessionProviderCollection,
	getPluginProviderRegistrationsFromCollection,
} from "@/modules/sessions/provider-collection";
import {
	nextChatSelection,
	resolveRestoredSessionSdkSelection,
	resolveSessionSdkPromptSelection,
	type SessionSdkSelectionDefaults,
	sessionSelectionDefaults,
} from "@/modules/sessions/selection";
import {
	projectSessionStorageError,
	requireSessionWriteReady,
} from "@/modules/sessions/storage/session-jsonl-store";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import type { SessionSendInput } from "@/modules/sessions/submission-types";
import { projectSessionMessageRecords } from "@/modules/sessions/transcript-projection";
import type { ConfigRuntime, ConfigStore } from "@/shared/config/config-store";
import { createConfigStore } from "@/shared/config/config-store";
import { type SessionId, toSessionId } from "@/shared/identifiers";
import { resolveUserWincodeDir } from "@/shared/paths/user-data-dir";

const sdkSnapshotFor = (snapshot: LiveSessionSnapshot): SessionSdkSnapshot => ({
	context: snapshot.context,
	storageError: projectSessionStorageError(snapshot.error),
	transcript: snapshot.transcript,
	turnActive: snapshot.turnActive,
});

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
		pluginFactories?: readonly SessionSdkPluginFactory[];
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
		projectTrust: _projectTrust,
		thinkingLevel: _thinkingLevel,
		...sharedOptions
	} = options;
	return {
		...sharedOptions,
		...(capabilityCeiling === undefined ? {} : { capabilityCeiling }),
	};
};

const closeUntransferredProviderCollection = async (
	providerCollection: ProviderCollection | undefined,
	ownershipTransferred: boolean
): Promise<void> => {
	if (!ownershipTransferred) {
		await providerCollection?.close().catch(() => undefined);
	}
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
	bundledPlugins,
	configRuntime,
	ignoreConfiguredPlugins,
	pluginPaths,
	selectedSources,
	projectTrust,
}: Readonly<{
	bundledPlugins: readonly SessionSdkPluginFactory[];
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
		bundledPlugins,
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
			.some((provider) => pluginProviderIdentityMatches(provider, source));
		if (!sourceIsRegistered) {
			await runtime.shutdown();
			throw new Error(
				`Selected Plugin Provider '${source.providerId}' from Plugin '${source.pluginId}' could not be verified in the child Session. Re-select it in Interactive Mode.`
			);
		}
	}
	return runtime;
};

const pluginProviderSourcesFor = (
	providerId: string,
	pluginRuntime: PluginRuntime | undefined,
	getPluginProviderSources:
		| SessionSdkRuntimeOptions["getPluginProviderSources"]
		| undefined
): readonly SessionSdkPluginProviderSource[] => {
	const registrations =
		pluginRuntime
			?.getProviderRegistrations()
			.filter((registration) => registration.providerId === providerId) ?? [];
	if (registrations.length > 0) {
		return registrations.map(
			({
				pluginId,
				providerId: registeredProviderId,
				sourceIdentity,
				sourcePath,
				sourceScope,
			}) => ({
				pluginId,
				providerId: registeredProviderId,
				sourceIdentity,
				sourcePath,
				...(sourceScope === undefined ? {} : { sourceScope }),
			})
		);
	}
	return (
		getPluginProviderSources?.([providerId]).filter(
			(source) => source.providerId === providerId
		) ?? []
	);
};

const currentSessionPluginProviderRegistration = (
	providerId: string,
	pluginRuntime: PluginRuntime | undefined,
	selectedSources: readonly SessionSdkPluginProviderSource[] | undefined,
	getPluginProviderSources:
		| SessionSdkRuntimeOptions["getPluginProviderSources"]
		| undefined
): SessionSdkPluginProviderSource | undefined => {
	const registrations = pluginProviderSourcesFor(
		providerId,
		pluginRuntime,
		getPluginProviderSources
	);
	if (registrations.length !== 1) {
		return;
	}
	const [registration] = registrations;
	if (registration === undefined) {
		return;
	}
	if (selectedSources !== undefined) {
		const matchingSources = selectedSources.filter(
			(source) => source.providerId === providerId
		);
		const [matchingSource] = matchingSources;
		if (
			matchingSources.length !== 1 ||
			matchingSource === undefined ||
			!pluginProviderIdentityMatches(registration, matchingSource)
		) {
			return;
		}
	}
	return registration;
};

const resolvePromptModelForHost = ({
	allowFreshOwnerBinding,
	getPluginProviderSources,
	host,
	model,
	pluginRuntime,
	selectedSources,
}: {
	allowFreshOwnerBinding: boolean;
	getPluginProviderSources:
		| SessionSdkRuntimeOptions["getPluginProviderSources"]
		| undefined;
	host: SessionHost;
	model: ProviderModelSelection;
	pluginRuntime: PluginRuntime | undefined;
	selectedSources: readonly SessionSdkPluginProviderSource[] | undefined;
}): ProviderModelSelection => {
	const registration = currentSessionPluginProviderRegistration(
		model.providerId,
		pluginRuntime,
		selectedSources,
		getPluginProviderSources
	);
	const trustedRegistrations = registration === undefined ? [] : [registration];
	const resolvedModel = resolveProviderModelSelectionForHost(
		model,
		trustedRegistrations,
		allowFreshOwnerBinding
	);
	if (
		resolvedModel === undefined ||
		!isPluginProviderSelectionBoundToTrustedOwner(
			resolvedModel,
			trustedRegistrations,
			getPluginProviderRegistrationsFromCollection(host.providerCollection)
		)
	) {
		throw new ProviderModelSelectionOwnershipError(model);
	}
	return resolvedModel;
};

const bindFreshSessionSdkSelectionToPluginOwner = (
	selection: SessionSdkSelectionDefaults,
	pluginRuntime: PluginRuntime | undefined,
	selectedSources: readonly SessionSdkPluginProviderSource[] | undefined,
	getPluginProviderSources:
		| SessionSdkRuntimeOptions["getPluginProviderSources"]
		| undefined
): SessionSdkSelectionDefaults => {
	if (selection.model.pluginProviderSource !== undefined) {
		return selection;
	}
	const registration = currentSessionPluginProviderRegistration(
		selection.model.providerId,
		pluginRuntime,
		selectedSources,
		getPluginProviderSources
	);
	if (registration === undefined) {
		return selection;
	}
	return {
		...selection,
		model: {
			...selection.model,
			pluginProviderSource: {
				pluginId: registration.pluginId,
				sourceIdentity: registration.sourceIdentity,
			},
		},
	};
};

const assertSessionSdkPluginProviderSelectionIsCurrent = (
	model: ProviderModelSelection,
	pluginRuntime: PluginRuntime | undefined,
	selectedSources: readonly SessionSdkPluginProviderSource[] | undefined,
	getPluginProviderSources:
		| SessionSdkRuntimeOptions["getPluginProviderSources"]
		| undefined
): void => {
	const registrations = pluginProviderSourcesFor(
		model.providerId,
		pluginRuntime,
		getPluginProviderSources
	);
	const selectedSourcesForProvider =
		selectedSources?.filter(
			(source) => source.providerId === model.providerId
		) ?? [];
	if (registrations.length === 0) {
		if (
			model.pluginProviderSource !== undefined ||
			selectedSourcesForProvider.length > 0
		) {
			throw new Error(
				`Plugin Provider selection ${model.providerId}/${model.modelId} has no matching trusted source; re-select it in Interactive Mode.`
			);
		}
		return;
	}
	const registration = currentSessionPluginProviderRegistration(
		model.providerId,
		pluginRuntime,
		selectedSources,
		getPluginProviderSources
	);
	if (
		registration === undefined ||
		!pluginProviderOwnerMatches(registration, model.pluginProviderSource)
	) {
		throw new Error(
			`Plugin Provider selection ${model.providerId}/${model.modelId} has no matching trusted source; re-select it in Interactive Mode.`
		);
	}
};

const assertRestoredSessionSdkPluginProviderSelectionIsSafe = (
	model: ProviderModelSelection,
	pluginRuntime: PluginRuntime | undefined,
	selectedSources: readonly SessionSdkPluginProviderSource[] | undefined,
	getPluginProviderSources:
		| SessionSdkRuntimeOptions["getPluginProviderSources"]
		| undefined,
	allowExistingHostOwnerCheck: boolean
): void => {
	if (allowExistingHostOwnerCheck && model.pluginProviderSource !== undefined) {
		// Keep the stored owner; the long-lived Host checks it before Agent Turn dispatch.
		return;
	}
	const registrations = pluginProviderSourcesFor(
		model.providerId,
		pluginRuntime,
		getPluginProviderSources
	);
	const selectedSourcesForProvider =
		selectedSources?.filter(
			(source) => source.providerId === model.providerId
		) ?? [];
	if (
		registrations.length === 0 &&
		selectedSourcesForProvider.length === 0 &&
		model.pluginProviderSource === undefined &&
		!isBuiltInProviderId(model.providerId)
	) {
		throw new Error(
			`Plugin Provider selection ${model.providerId}/${model.modelId} has no matching trusted source; re-select it in Interactive Mode.`
		);
	}
	assertSessionSdkPluginProviderSelectionIsCurrent(
		model,
		pluginRuntime,
		selectedSources,
		getPluginProviderSources
	);
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

const promptInputFor = async (
	input: SessionSdkPrompt,
	defaults: SessionSdkSelectionDefaults,
	registry: AgentRegistry | null,
	host: SessionHost,
	pluginRuntime: PluginRuntime | undefined,
	selectedSources: readonly SessionSdkPluginProviderSource[] | undefined,
	getPluginProviderSources:
		| SessionSdkRuntimeOptions["getPluginProviderSources"]
		| undefined
): Promise<SessionSendInput> => {
	host.assertCurrentPluginProviderRegistrationSnapshot();
	const resolvedSelection = resolveSessionSdkPromptSelection(input, defaults);
	const resolveModelForHost = (
		model: ProviderModelSelection,
		allowFreshOwnerBinding: boolean
	): ProviderModelSelection =>
		resolvePromptModelForHost({
			allowFreshOwnerBinding,
			getPluginProviderSources,
			host,
			model,
			pluginRuntime,
			selectedSources,
		});
	const selection = {
		...resolvedSelection,
		model: resolveModelForHost(
			resolvedSelection.model,
			input.model !== undefined
		),
	};
	const pinnedAgentModel = registry?.agents.find(
		(candidate) => candidate.id === selection.agent
	)?.model;
	const hasExplicitModelReplacement =
		input.model !== undefined ||
		(pinnedAgentModel !== undefined &&
			!(
				isSameProviderModelIdentity(pinnedAgentModel, selection.model) &&
				pluginProviderOwnerMatches(
					pinnedAgentModel.pluginProviderSource,
					selection.model.pluginProviderSource
				)
			));
	const usesPinnedAgentModel =
		pinnedAgentModel !== undefined &&
		isSameProviderModelIdentity(pinnedAgentModel, selection.model) &&
		pluginProviderOwnerMatches(
			pinnedAgentModel.pluginProviderSource,
			selection.model.pluginProviderSource
		);
	const explicitSelectionOverride = hasExplicitModelReplacement
		? { model: selection.model }
		: undefined;
	const preAvailabilityEffective = resolveEffectiveAgentSelection(
		registry,
		selection.agent,
		selection.model,
		selection,
		false,
		explicitSelectionOverride
	);
	if (preAvailabilityEffective.unavailableReason !== undefined) {
		throw new Error(preAvailabilityEffective.unavailableReason);
	}
	const effectiveBeforeAvailability = {
		...preAvailabilityEffective,
		model: resolveModelForHost(preAvailabilityEffective.model, false),
	};
	const availableProviderModels: readonly ProviderModel[] | undefined =
		host.providerCollection === undefined
			? undefined
			: await host.providerCollection.getAvailable(
					effectiveBeforeAvailability.model.providerId
				);
	if (
		usesPinnedAgentModel &&
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
		selectionOverride
	);
	if (effective.unavailableReason !== undefined) {
		throw new Error(effective.unavailableReason);
	}
	if (
		!(
			isSameProviderModelIdentity(
				effective.model,
				effectiveBeforeAvailability.model
			) &&
			pluginProviderOwnerMatches(
				effective.model.pluginProviderSource,
				effectiveBeforeAvailability.model.pluginProviderSource
			)
		)
	) {
		throw new ProviderModelSelectionOwnershipError(effective.model);
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
		sessionModel: input.model === undefined ? defaults.model : selection.model,
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
	defaults: SessionSdkSelectionDefaults,
	pluginRuntime: PluginRuntime | undefined,
	selectedSources: readonly SessionSdkPluginProviderSource[] | undefined,
	getPluginProviderSources:
		| SessionSdkRuntimeOptions["getPluginProviderSources"]
		| undefined
): SessionSdkHandle => {
	const { capabilities } = assembly;
	let disposed = false;
	let disposePromise: Promise<void> | undefined;
	let currentDefaults = defaults;
	const admitPrompt = async (
		input: SessionSdkPrompt,
		selectionDefaults: SessionSdkSelectionDefaults,
		promptRegistry: AgentRegistry | null,
		currentPluginRuntime: PluginRuntime | undefined
	): Promise<{
		admission: SessionSubmissionAdmission;
		sendInput?: SessionSendInput;
	}> => {
		let sendInput: SessionSendInput | undefined;
		const admission = await host.withSessionWork(
			async () => {
				sendInput = await promptInputFor(
					input,
					selectionDefaults,
					promptRegistry,
					host,
					currentPluginRuntime,
					selectedSources,
					getPluginProviderSources
				);
				host.assertCurrentPluginProviderRegistrationSnapshot();
				return await host.agentSession.prompt(sendInput);
			},
			(reason) => ({ rejected: true as const, reason })
		);
		return {
			admission,
			...(sendInput === undefined ? {} : { sendInput }),
		};
	};
	const prompt: SessionSdkHandle["prompt"] = async (input) => {
		if (disposed) {
			return { reason: "Session handle is disposed.", rejected: true };
		}
		const { admission, sendInput } = await admitPrompt(
			input,
			currentDefaults,
			capabilities.getRegistry(),
			capabilities.getPluginRuntime?.() ?? pluginRuntime
		);
		if (!admission.rejected && sendInput !== undefined) {
			currentDefaults = {
				agent: sendInput.agent,
				model: sendInput.sessionModel,
				...omitUndefined({
					thinkingLevel: sendInput.sessionThinkingLevel,
				}),
			};
		}
		return admission;
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
			const snapshot = host.getSnapshot();
			const writeOutcome = projectSessionStorageError(
				snapshot.error
			)?.writeOutcome;
			const message = snapshot.transcript.find(
				(entry) => entry.metadata?.submissionId === submissionId
			);
			if (message !== undefined) {
				settled = true;
				committed.resolve({
					...accepted,
					messageId: message.id,
					...(writeOutcome === undefined ? {} : { writeOutcome }),
				});
				return;
			}
			if (failureReason !== undefined) {
				settled = true;
				committed.resolve({
					rejected: true,
					reason: failureReason,
					...(writeOutcome === undefined ? {} : { writeOutcome }),
				});
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
				const writeOutcome = projectSessionStorageError(
					host.getSnapshot().error
				)?.writeOutcome;
				return {
					...admission,
					...(writeOutcome === undefined ? {} : { writeOutcome }),
				};
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
			return promptAndWaitForDurableDelivery(
				submissionId,
				async () =>
					(
						await admitPrompt(
							{ text: input.text, submissionId },
							defaults,
							capabilities.getRegistry(),
							pluginRuntime
						)
					).admission
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
			listener(sdkSnapshotFor(host.getSnapshot()));
			return host.subscribe(() => listener(sdkSnapshotFor(host.getSnapshot())));
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
		bundledPlugins: options.pluginFactories ?? [],
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
		getPluginProviderSources,
		model,
		pluginFactories: _pluginFactories,
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
	const unresolvedDefaultSelection = sessionSelectionDefaults(
		assembly.capabilities.getRegistry(),
		{
			...(agent === undefined ? {} : { agent }),
			...(model === undefined ? {} : { model }),
			...(thinkingLevel === undefined ? {} : { thinkingLevel }),
		}
	);
	const defaultSelection =
		agent === undefined && model === undefined
			? unresolvedDefaultSelection
			: bindFreshSessionSdkSelectionToPluginOwner(
					unresolvedDefaultSelection,
					pluginRuntime,
					inheritedPluginProviderSources,
					getPluginProviderSources
				);
	const bindNewSessionSelection = (
		selection: SessionSdkSelectionDefaults
	): SessionSdkSelectionDefaults => {
		const boundSelection = bindFreshSessionSdkSelectionToPluginOwner(
			selection,
			pluginRuntime,
			inheritedPluginProviderSources,
			getPluginProviderSources
		);
		if (
			!isBuiltInProviderId(boundSelection.model.providerId) &&
			boundSelection.model.pluginProviderSource === undefined
		) {
			throw new ProviderModelSelectionOwnershipError(boundSelection.model);
		}
		assertSessionSdkPluginProviderSelectionIsCurrent(
			boundSelection.model,
			pluginRuntime,
			inheritedPluginProviderSources,
			getPluginProviderSources
		);
		return boundSelection;
	};
	const openSession = async (
		id: SessionId | string,
		openOptions: Readonly<{ autoContinue?: boolean; view?: boolean }> = {},
		selection = defaultSelection,
		providerCollection?: ProviderCollection
	): Promise<SessionSdkHandle> => {
		let providerCollectionTransferred = false;
		try {
			if (disposed) {
				throw new Error("Session SDK is disposed.");
			}
			const sessionId = toSessionId(id);
			const stored = await assembly.store.getSession(sessionId);
			const records = await assembly.store.listSessionRecords(sessionId);
			const priorSelection = nextChatSelection({
				messages: records.flatMap((record) =>
					projectSessionMessageRecords(record.messages, record)
				),
			});
			const hasStoredProviderModelSelection =
				stored.model !== undefined || priorSelection !== null;
			const fallbackSelection = hasStoredProviderModelSelection
				? selection
				: bindNewSessionSelection(selection);
			const restoredDefaults = resolveRestoredSessionSdkSelection(
				fallbackSelection,
				stored,
				priorSelection
			);
			assertRestoredSessionSdkPluginProviderSelectionIsSafe(
				restoredDefaults.model,
				pluginRuntime,
				inheritedPluginProviderSources,
				getPluginProviderSources,
				shared !== undefined && inheritedPluginProviderSources === undefined
			);
			providerCollectionTransferred = providerCollection !== undefined;
			const host = await assembly.capabilities
				.getSessionHostManager()
				.openHost({
					autoContinue: openOptions.autoContinue ?? true,
					capabilities: assembly.capabilities,
					...(providerCollection === undefined ? {} : { providerCollection }),
					...(hasStoredProviderModelSelection ||
					fallbackSelection.model.pluginProviderSource === undefined
						? {}
						: { providerModel: fallbackSelection.model }),
					sessionId,
					view: openOptions.view ?? true,
				});
			const defaults = resolveRestoredSessionSdkSelection(
				fallbackSelection,
				stored,
				hasStoredProviderModelSelection ? host.getSelection() : null
			);
			assertRestoredSessionSdkPluginProviderSelectionIsSafe(
				defaults.model,
				pluginRuntime,
				inheritedPluginProviderSources,
				getPluginProviderSources,
				shared !== undefined && inheritedPluginProviderSources === undefined
			);
			const handle = handleFor(
				assembly,
				host,
				sessionId,
				defaults,
				pluginRuntime,
				inheritedPluginProviderSources,
				getPluginProviderSources
			);
			handles.add(handle);
			return handle;
		} finally {
			await closeUntransferredProviderCollection(
				providerCollection,
				providerCollectionTransferred
			);
		}
	};
	const createEmptySession: SessionSdk["createEmptySession"] = async (
		createOptions
	) => {
		if (disposed) {
			throw new Error("Session SDK is disposed.");
		}
		const resolvedSelection = sessionSelectionDefaults(
			assembly.capabilities.getRegistry(),
			omitUndefined({
				agent: createOptions?.agent ?? agent,
				model: createOptions?.model ?? model,
				thinkingLevel: createOptions?.thinkingLevel ?? thinkingLevel,
			})
		);
		const selection = bindNewSessionSelection(resolvedSelection);
		const id = createOptions?.sessionId ?? toSessionId(randomUUIDv7());
		const providerCollection =
			await createValidatedPluginProviderCollectionForSelection(
				selection.model,
				assembly.capabilities,
				id,
				[selection.model.providerId]
			);
		try {
			const created = await assembly.store.createEmptySession(
				omitUndefined({
					id,
					model: selection.model,
					thinkingLevel: selection.thinkingLevel,
				})
			);
			requireSessionWriteReady(created.writeOutcome);
			return id;
		} finally {
			await providerCollection.close().catch(() => undefined);
		}
	};
	const createSession = async (
		createOptions?: SessionSdkCreateOptions
	): Promise<SessionSdkHandle> => {
		if (disposed) {
			throw new Error("Session SDK is disposed.");
		}
		const resolvedSelection = sessionSelectionDefaults(
			assembly.capabilities.getRegistry(),
			omitUndefined({
				agent: createOptions?.agent ?? agent,
				model: createOptions?.model ?? model,
				thinkingLevel: createOptions?.thinkingLevel ?? thinkingLevel,
			})
		);
		const selection = bindNewSessionSelection(resolvedSelection);
		const id = createOptions?.sessionId ?? toSessionId(randomUUIDv7());
		const providerCollection =
			await createValidatedPluginProviderCollectionForSelection(
				selection.model,
				assembly.capabilities,
				id,
				[selection.model.providerId]
			);
		let providerCollectionTransferred = false;
		try {
			if (createOptions?.initialPrompt !== undefined) {
				await providerCollection.restoreModels();
				const availableProviderModels = await providerCollection.getAvailable(
					selection.model.providerId
				);
				if (
					!isAvailableProviderModelSelection(
						selection.model,
						availableProviderModels
					)
				) {
					throw new Error(
						`Provider Model ${selection.model.providerId}/${selection.model.modelId} is unavailable in this Session Host.`
					);
				}
			}
			let createdNew = true;
			if (createOptions?.initialPrompt === undefined) {
				const created = await assembly.store.createEmptySession(
					omitUndefined({
						id,
						model: selection.model,
						thinkingLevel:
							createOptions?.thinkingLevel ?? selection.thinkingLevel,
					})
				);
				requireSessionWriteReady(created.writeOutcome);
				createdNew = created.created !== false;
			} else {
				const created = await assembly.store.createSession({
					agent: selection.agent,
					id,
					message: createSessionUserMessage(
						createOptions.initialPrompt,
						{
							agent: selection.agent,
							model: selection.model,
							...omitUndefined({
								thinkingLevel:
									createOptions.thinkingLevel ?? selection.thinkingLevel,
							}),
						},
						[],
						[],
						toSessionMessageId(`initial-${id}`)
					),
					model: selection.model,
					thinkingLevel: createOptions.thinkingLevel ?? selection.thinkingLevel,
					turnId: toAgentTurnId(`initial-${id}`),
				});
				requireSessionWriteReady(created.writeOutcome);
				createdNew = created.created !== false;
			}
			providerCollectionTransferred = true;
			const handle = await openSession(id, {}, selection, providerCollection);
			if (createOptions?.initialPrompt !== undefined && createdNew) {
				handle.continue();
			}
			return handle;
		} finally {
			await closeUntransferredProviderCollection(
				providerCollection,
				providerCollectionTransferred
			);
		}
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
			getPluginProviderSources?.(requestedProviderIds) ??
			pluginRuntime
				.getProviderRegistrations()
				.filter((provider) =>
					requestedProviderIds.includes(provider.providerId)
				)
				.map((provider) => {
					const inheritedSource = inheritedPluginProviderSources?.find(
						(source) => pluginProviderIdentityMatches(source, provider)
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
				pluginFactories: runtimeOptions.pluginFactories ?? [],
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
			(catalogRegistry?.agents ?? []).map((agent) => ({
				description: agent.description,
				id: agent.id,
				isAvailable: agent.isAvailable,
				...(agent.model === undefined ? {} : { model: agent.model }),
				...(agent.thinkingLevel === undefined
					? {}
					: { thinkingLevel: agent.thinkingLevel }),
				role: agent.role,
				...(agent.source === undefined ? {} : { source: agent.source.scope }),
				...(agent.requiredTools === undefined
					? {}
					: { requiredTools: agent.requiredTools }),
				...(agent.unavailableReason === undefined
					? {}
					: { unavailableReason: agent.unavailableReason }),
			}))
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
	const createSessionRuntime: SessionSdkOperations["createSessionRuntime"] =
		async (runtimeOptions = {}) => {
			const runtimeCapabilityCeiling = snapshotCapabilityCeiling(
				capabilityCeiling,
				runtimeOptions.capabilityCeiling
			);
			const selectedProviderIds = new Set(
				runtimeOptions.pluginProviderIds ?? []
			);
			if (runtimeOptions.sessionId !== undefined) {
				const storedSession = await store.getSession(
					toSessionId(runtimeOptions.sessionId)
				);
				if (storedSession.model !== undefined) {
					selectedProviderIds.add(storedSession.model.providerId);
				}
			}
			const requestedProviderIds = [...selectedProviderIds];
			const availableProviderSources =
				hostRuntimeOptions.getPluginProviderSources?.(requestedProviderIds) ??
				hostRuntimeOptions.pluginProviderSources ??
				[];
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
			return createSessionSdkInternal(
				{
					...optionsForSessionRuntime(
						hostRuntimeOptions,
						runtimeCapabilityCeiling
					),
					getPluginProviderSources: hostRuntimeOptions.getPluginProviderSources,
					pluginFactories: runtimeOptions.pluginFactories ?? [],
					pluginPaths: runtimeOptions.pluginPaths ?? [],
					...(requestedProviderIds.length === 0
						? {}
						: { pluginProviderSources: selectedPluginProviderSources }),
					...(runtimeOptions.projectTrust === undefined
						? {}
						: { projectTrust: runtimeOptions.projectTrust }),
					store,
				},
				{ ignoreConfiguredPlugins: true, manager, store }
			);
		};
	const withSessionRuntime = async <Result>(
		operation: (sdk: SessionSdk) => Promise<Result>,
		runtimeOptions?: SessionRuntimeOptions
	): Promise<Result> => {
		const sdk = await createSessionRuntime(runtimeOptions);
		try {
			return await operation(sdk);
		} finally {
			await sdk.dispose();
		}
	};
	return {
		createSessionRuntime,
		createEmptySession: (createOptions) =>
			withSessionRuntime((sdk) => sdk.createEmptySession(createOptions), {
				pluginProviderIds:
					createOptions?.model === undefined
						? []
						: [createOptions.model.providerId],
			}),
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
