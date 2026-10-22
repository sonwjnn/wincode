import {
	type AgentId,
	type AgentTurnEvent,
	agentIdSchema,
} from "@wincode/agent-core";
import type { ProviderCollection, ProviderModel } from "@wincode/ai";
import {
	type ThinkingLevel,
	type ThinkingSelection,
	thinkingLevelSchema,
} from "@wincode/ai";
import { getErrorMessage, omitUndefined } from "@wincode/utils";
import { randomUUIDv7 } from "bun";
import {
	type AgentSelectionOverride,
	resolveEffectiveAgentSelection,
	withAvailableAgentModelOverride,
} from "@/modules/agents/agent-call";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import {
	bindProviderModelSelectionToPluginOwner,
	DEFAULT_PROVIDER_MODEL_SELECTION,
	isAvailableProviderModelSelection,
	isSameProviderModelIdentity,
	normalizeProviderModelSelection,
	normalizeProviderModelThinkingSelection,
	type PluginProviderOwnerRegistration,
	type ProviderModelSelection,
	parseProviderModelSelection,
	pluginProviderOwnerMatches,
	resolveProviderModelSelectionForHost,
} from "@/modules/providers/provider-model-selection";
import { resolveWorkspaceRoot } from "@/modules/tools";
import type { ConfigRuntime } from "@/shared/config/config-store";
import type { AgentRegistry } from "../../../modules/agents/registry";
import {
	assertPluginProviderSelectionOwner,
	createValidatedPluginProviderCollectionForSelection,
} from "../../../modules/sessions/host/agent-session-turn-runner";
import type { SessionServices } from "../../../modules/sessions/host/session-services";
import type {
	SessionHost,
	SessionHostManager,
} from "../../../modules/sessions/host/types";
import {
	type ResolvedSessionSelection,
	restoreSelection,
} from "../../../modules/sessions/selection";
import { projectSessionMessageRecords } from "../../../modules/sessions/storage/session-record";
import type { SessionSendInput } from "../../../modules/sessions/submission-types";
import { type SessionId, toSessionId } from "../../../shared/identifiers";
import { openApplicationSessionServices } from "../plugin-composition";
import { projectAgentEvent } from "../rpc/projection";
import type { ApplicationContext } from "./types";
import { InvocationError } from "./types";

type OneShotFormat = "json" | "print";

type OneShotCompositionInput = Readonly<{
	configRuntime?: ConfigRuntime;
	cwd: string;
	pluginRuntime?: PluginRuntime;
	disabledPluginIds?: readonly string[];
	pluginPaths?: readonly string[];
	workspace: string;
}>;

type OneShotComposition = Readonly<{
	services: SessionServices;
}>;

type OneShotDependencies = Readonly<{
	composeServices?: (
		input: OneShotCompositionInput
	) => Promise<OneShotComposition>;
}>;

const composeOneShotServices = async (
	context: ApplicationContext,
	workspace: string,
	compose: NonNullable<OneShotDependencies["composeServices"]>
): Promise<OneShotComposition> =>
	compose({
		cwd: context.cwd,
		...omitUndefined({
			configRuntime: context.configRuntime,
			pluginRuntime: context.pluginRuntime,
		}),
		disabledPluginIds: context.invocation.disabledPlugins,
		pluginPaths: context.invocation.pluginPaths ?? [],
		workspace,
	});

type ResolvedSelection = Readonly<{
	agent: AgentId;
	model: ProviderModelSelection;
	selectionOverride?: AgentSelectionOverride;
	resolvedAgent?: SessionSendInput["resolvedAgent"];
}> &
	ThinkingSelection;

type OneShotResult = Readonly<{
	terminalFailureMessage?: string;
	terminalSucceeded: boolean;
}>;

const DEFAULT_THINKING_LEVEL: ThinkingLevel = "low";

const decodeInput = async (
	input: ApplicationContext["stdin"]
): Promise<string> => {
	if (input === undefined) {
		return "";
	}
	const decoder = new TextDecoder();
	let text = "";
	for await (const chunk of input) {
		text += decoder.decode(chunk, { stream: true });
	}
	return `${text}${decoder.decode()}`;
};

const readSubmission = async (context: ApplicationContext): Promise<string> => {
	const prompt = context.invocation.prompt;
	const stdinText = context.stdinIsTTY ? "" : await decodeInput(context.stdin);
	if (prompt !== undefined && stdinText.length > 0) {
		throw new InvocationError(
			"Provide a Submission with --prompt or stdin, not both.",
			2
		);
	}
	const submission = (prompt ?? stdinText).trim();
	if (submission.length === 0) {
		throw new InvocationError(
			"A non-empty Submission is required from --prompt or stdin.",
			2
		);
	}
	return submission;
};

const parseAgent = (value: string | undefined): AgentId | undefined => {
	if (value === undefined) {
		return;
	}
	const parsed = agentIdSchema.safeParse(value);
	if (!parsed.success) {
		throw new InvocationError(`Invalid Agent selector: ${value}`);
	}
	return parsed.data;
};

const parseModel = (
	value: string | undefined
): ProviderModelSelection | undefined => {
	if (value === undefined) {
		return;
	}
	const parsed = normalizeProviderModelSelection(
		parseProviderModelSelection(value)
	);
	if (parsed === null) {
		throw new InvocationError(`Invalid Model selector: ${value}`);
	}
	return parsed;
};

const candidateAgent = (
	registry: AgentRegistry | null,
	agent: AgentId
): AgentRegistry["agents"][number] | undefined =>
	registry?.agents.find((candidate) => candidate.id === agent);

const resolveExplicitThinkingLevel = (
	value: string,
	providerModel: ProviderModel
): ThinkingLevel => {
	const parsed = thinkingLevelSchema.safeParse(value);
	if (!parsed.success) {
		throw new InvocationError(`Invalid --thinking-level value: ${value}`);
	}
	const normalized = normalizeProviderModelThinkingSelection(providerModel, {
		thinkingLevel: parsed.data,
	});
	if (normalized.thinkingLevel !== parsed.data) {
		throw new InvocationError(`Invalid --thinking-level value: ${value}`);
	}
	return parsed.data;
};

type ResolvedOneShotModel = Readonly<{
	agent: AgentId;
	model: ProviderModelSelection;
	providerModel: ProviderModel;
	selectionOverride?: AgentSelectionOverride;
	resolvedAgent?: SessionSendInput["resolvedAgent"];
}>;

/** Current registry Agents are fresh; Plugin Agents also need a matching registration. */
const isCurrentAgentModelPin = (
	candidate: AgentRegistry["agents"][number] | undefined,
	pluginRuntime: PluginRuntime | undefined
): boolean => {
	const source = candidate?.source;
	const model = candidate?.model;
	if (candidate === undefined || source === undefined || model === undefined) {
		return false;
	}
	if (source.kind !== "markdown") {
		return source.kind === "builtin" || source.kind === "config";
	}
	if (pluginRuntime === undefined) {
		return false;
	}
	return pluginRuntime.getAgentRegistrations().some((registration) => {
		if (
			registration.agent.id !== candidate.id ||
			registration.source.path !== source.path ||
			registration.source.scope !== source.scope ||
			registration.model === undefined
		) {
			return false;
		}
		const registeredModel = parseProviderModelSelection(registration.model);
		return (
			registeredModel !== null &&
			isSameProviderModelIdentity(registeredModel, model)
		);
	});
};

const currentPluginProviderOwner = (
	providerId: string,
	pluginRuntime: PluginRuntime | undefined
): PluginProviderOwnerRegistration | undefined => {
	const registrations =
		pluginRuntime
			?.getProviderRegistrations()
			.filter((registration) => registration.providerId === providerId) ?? [];
	return registrations.length === 1 ? registrations[0] : undefined;
};

const currentAgentPluginProviderOwner = ({
	candidate,
	pluginRuntime,
	restoredModel,
}: {
	candidate: AgentRegistry["agents"][number] | undefined;
	pluginRuntime: PluginRuntime | undefined;
	restoredModel: ProviderModelSelection | undefined;
}): PluginProviderOwnerRegistration | undefined => {
	const model = candidate?.model;
	if (
		restoredModel !== undefined ||
		model === undefined ||
		!isCurrentAgentModelPin(candidate, pluginRuntime)
	) {
		return;
	}
	return currentPluginProviderOwner(model.providerId, pluginRuntime);
};

const resolveOneShotModel = ({
	agent,
	availableProviderModels,
	knownProviderModels,
	candidate,
	candidatePluginProviderOwner,
	explicitModel,
	explicitPluginProviderOwner,
	registry,
	restored,
}: {
	agent: AgentId;
	availableProviderModels?: readonly ProviderModel[];
	knownProviderModels?: readonly ProviderModel[];
	candidate: AgentRegistry["agents"][number] | undefined;
	candidatePluginProviderOwner?: PluginProviderOwnerRegistration;
	explicitModel: ProviderModelSelection | undefined;
	explicitPluginProviderOwner?: PluginProviderOwnerRegistration;
	registry: AgentRegistry | null;
	restored: ResolvedSessionSelection | null;
}): ResolvedOneShotModel => {
	const restoredModel = restored?.model;
	const candidateModel =
		candidate?.model === undefined
			? undefined
			: bindProviderModelSelectionToPluginOwner(
					candidate.model,
					candidatePluginProviderOwner
				);
	const model =
		(explicitModel === undefined
			? undefined
			: bindProviderModelSelectionToPluginOwner(
					explicitModel,
					explicitPluginProviderOwner
				)) ??
		restoredModel ??
		candidateModel ??
		DEFAULT_PROVIDER_MODEL_SELECTION;
	if (availableProviderModels === undefined) {
		throw new InvocationError(
			"Provider SDK runtime is unavailable in headless modes."
		);
	}
	if (!isAvailableProviderModelSelection(model, availableProviderModels)) {
		if (
			knownProviderModels !== undefined &&
			isAvailableProviderModelSelection(model, knownProviderModels)
		) {
			throw new InvocationError(
				`Connect ${model.providerId} in Interactive Mode to use Model ${model.modelId}, then retry.`
			);
		}
		throw new InvocationError(
			`Provider Model ${model.providerId}/${model.modelId} is unavailable in this One-Shot Host.`
		);
	}
	const candidateMatchesSelectedModel =
		candidate?.model !== undefined &&
		isSameProviderModelIdentity(candidate.model, model) &&
		pluginProviderOwnerMatches(
			candidate.model.pluginProviderSource,
			model.pluginProviderSource
		);
	const explicitModelOverride =
		explicitModel !== undefined ||
		candidatePluginProviderOwner !== undefined ||
		(restoredModel !== undefined && !candidateMatchesSelectedModel)
			? { model }
			: undefined;
	const selectionOverride = withAvailableAgentModelOverride(
		registry,
		agent,
		explicitModelOverride,
		availableProviderModels
	);
	const effective = resolveEffectiveAgentSelection(
		registry,
		agent,
		model,
		restored?.thinkingLevel === undefined
			? {}
			: { thinkingLevel: restored.thinkingLevel },
		false,
		selectionOverride
	);
	if (
		effective.agent !== agent ||
		effective.unavailableReason !== undefined ||
		(candidate !== undefined && effective.resolvedAgent === undefined)
	) {
		throw new InvocationError(
			effective.unavailableReason ?? `Agent is unavailable: ${agent}`
		);
	}
	if (
		!isAvailableProviderModelSelection(effective.model, availableProviderModels)
	) {
		throw new InvocationError(
			`Provider Model ${effective.model.providerId}/${effective.model.modelId} is unavailable in this One-Shot Host.`
		);
	}
	const effectiveProviderModel = availableProviderModels.find((available) =>
		isSameProviderModelIdentity(available, effective.model)
	);
	if (effectiveProviderModel === undefined) {
		throw new InvocationError(
			`Provider Model ${effective.model.providerId}/${effective.model.modelId} is unavailable in this One-Shot Host.`
		);
	}
	return {
		agent: effective.agent,
		model: effective.model,
		resolvedAgent: effective.resolvedAgent,
		...(selectionOverride === undefined ? {} : { selectionOverride }),
		providerModel: effectiveProviderModel,
	};
};

const resolveSelection = ({
	agentOption,
	availableProviderModels,
	knownProviderModels,
	thinkingLevelOption,
	modelOption,
	candidatePluginProviderOwner,
	explicitPluginProviderOwner,
	restored,
	registry,
}: {
	agentOption: string | undefined;
	availableProviderModels?: readonly ProviderModel[];
	knownProviderModels?: readonly ProviderModel[];
	thinkingLevelOption: string | undefined;
	modelOption: string | undefined;
	candidatePluginProviderOwner?: PluginProviderOwnerRegistration;
	explicitPluginProviderOwner?: PluginProviderOwnerRegistration;
	registry: AgentRegistry | null;
	restored: ResolvedSessionSelection | null;
}): ResolvedSelection => {
	const explicitAgent = parseAgent(agentOption);
	const explicitModel = parseModel(modelOption);
	const agent =
		explicitAgent ??
		restored?.agent ??
		registry?.defaultAgentId ??
		agentIdSchema.parse("build");
	const candidate = candidateAgent(registry, agent);
	if (registry !== null && candidate === undefined) {
		throw new InvocationError(`Agent is unavailable: ${agent}`);
	}
	if (
		candidate?.role === "subagent" ||
		(availableProviderModels === undefined &&
			candidate !== undefined &&
			!(candidate.isAvailable && candidate.isSelectable))
	) {
		throw new InvocationError(`Agent is unavailable: ${agent}`);
	}
	const effective = resolveOneShotModel({
		agent,
		availableProviderModels,
		knownProviderModels,
		candidate,
		candidatePluginProviderOwner,
		explicitModel,
		explicitPluginProviderOwner,
		registry,
		restored,
	});
	const thinkingChoice =
		thinkingLevelOption === undefined
			? (restored?.thinkingLevel ??
				candidate?.thinkingLevel ??
				DEFAULT_THINKING_LEVEL)
			: resolveExplicitThinkingLevel(
					thinkingLevelOption,
					effective.providerModel
				);
	const selection = normalizeProviderModelThinkingSelection(
		effective.providerModel,
		{ thinkingLevel: thinkingChoice }
	);
	return {
		agent: effective.agent,
		model: effective.model,
		resolvedAgent: effective.resolvedAgent,
		...(effective.selectionOverride === undefined
			? {}
			: { selectionOverride: effective.selectionOverride }),
		...selection,
	};
};

const composeDefaultServices = async ({
	configRuntime,
	cwd,
	pluginRuntime,
	disabledPluginIds = [],
	pluginPaths = [],
	workspace,
}: OneShotCompositionInput): Promise<OneShotComposition> => ({
	services: await openApplicationSessionServices({
		cwd,
		disabledPluginIds,
		pluginPaths,
		workspace,
		...(configRuntime === undefined ? {} : { configRuntime }),
		...(pluginRuntime === undefined ? {} : { pluginRuntime }),
	}),
});

const sendInputFor = (
	selection: ResolvedSelection,
	text: string
): SessionSendInput => ({
	agent: selection.agent,
	composition: { files: [], text },
	model: selection.model,
	resolvedAgent: selection.resolvedAgent,
	sessionModel: selection.model,
	...(selection.thinkingLevel === undefined
		? {}
		: {
				thinkingLevel: selection.thinkingLevel,
				sessionThinkingLevel: selection.thinkingLevel,
			}),
	...(selection.selectionOverride === undefined
		? {}
		: { selectionOverride: selection.selectionOverride }),
	userText: text,
});

const emitJsonEvent = (
	context: ApplicationContext,
	event: AgentTurnEvent,
	sessionId?: SessionId
): void => {
	const projectedEvent = projectAgentEvent(event);
	context.stdout.write(
		`${JSON.stringify(
			sessionId === undefined
				? projectedEvent
				: { ...projectedEvent, sessionId }
		)}\n`
	);
};
const plannedSessionIdForOneShot = (
	existingSessionId: SessionId | undefined
): SessionId => existingSessionId ?? toSessionId(randomUUIDv7());

const initializeOneShotSession = async (
	context: ApplicationContext,
	services: SessionServices,
	plannedSessionId: SessionId
): Promise<{ isNewSession: boolean; sessionId: SessionId }> => {
	const existingSessionId =
		context.invocation.session === undefined
			? undefined
			: toSessionId(context.invocation.session);
	if (existingSessionId !== undefined) {
		return { isNewSession: false, sessionId: existingSessionId };
	}
	const created = await services.store.createEmptySession({
		id: plannedSessionId,
	});
	return { isNewSession: true, sessionId: created.id };
};

type OneShotHostPreflight = Readonly<{
	explicitAgent?: AgentId;
	explicitModel?: ProviderModelSelection;
	pluginRuntime?: PluginRuntime;
	providerCollection?: ProviderCollection;
	providerModel: ProviderModelSelection;
	registry: AgentRegistry | null;
}>;

const preflightOneShotHost = async (
	context: ApplicationContext,
	services: SessionServices,
	sessionId: SessionId | undefined,
	plannedSessionId: SessionId
): Promise<OneShotHostPreflight> => {
	const registry = services.capabilities.getRegistry();
	const [storedSession, storedRecords] =
		sessionId === undefined
			? [undefined, []]
			: await Promise.all([
					services.store.getSession(sessionId),
					services.store.listSessionRecords(sessionId),
				]);
	// The Session's recorded tiers: the row choice, then the newest message pair.
	const restoredSelection = restoreSelection({
		messages: storedRecords.flatMap((record) =>
			projectSessionMessageRecords(record.messages, record)
		),
		...(storedSession === undefined ? {} : { row: storedSession }),
	});
	const explicitAgent = parseAgent(context.invocation.agent);
	const explicitModel = parseModel(context.invocation.model);
	const restoredModel =
		explicitAgent === undefined ? restoredSelection?.model : undefined;
	const selectedAgent =
		explicitAgent ??
		restoredSelection?.agent ??
		registry?.defaultAgentId ??
		agentIdSchema.parse("build");
	const candidate = candidateAgent(registry, selectedAgent);
	const pluginRuntime = services.capabilities.getPluginRuntime?.();
	const candidatePluginProviderOwner = currentAgentPluginProviderOwner({
		candidate,
		pluginRuntime,
		restoredModel,
	});
	const candidateModel =
		candidate?.model === undefined
			? undefined
			: bindProviderModelSelectionToPluginOwner(
					candidate.model,
					candidatePluginProviderOwner
				);
	const selectedProviderModel =
		explicitModel ??
		restoredModel ??
		candidateModel ??
		DEFAULT_PROVIDER_MODEL_SELECTION;
	const providerModel = resolveProviderModelSelectionForHost(
		selectedProviderModel,
		pluginRuntime?.getProviderRegistrations() ?? [],
		explicitModel !== undefined || candidatePluginProviderOwner !== undefined
	);
	if (providerModel === undefined) {
		throw new Error("One-Shot Provider Model selection is unavailable.");
	}
	const providerCollection =
		sessionId === undefined
			? await createValidatedPluginProviderCollectionForSelection(
					providerModel,
					services.capabilities,
					plannedSessionId,
					[providerModel.providerId]
				)
			: undefined;
	return {
		...(explicitAgent === undefined ? {} : { explicitAgent }),
		...(providerCollection === undefined ? {} : { providerCollection }),
		...(explicitModel === undefined ? {} : { explicitModel }),
		...(pluginRuntime === undefined ? {} : { pluginRuntime }),
		providerModel,
		registry,
	};
};

const resolveFreshOneShotSelection = async (
	context: ApplicationContext,
	preflight: OneShotHostPreflight
): Promise<ResolvedSelection> => {
	const {
		explicitAgent,
		explicitModel,
		pluginRuntime,
		providerCollection,
		providerModel,
		registry,
	} = preflight;
	await providerCollection?.restoreModels();
	const availableProviderModels = await providerCollection?.getAvailable(
		providerModel.providerId
	);
	const knownProviderModels = providerCollection?.getModels();
	const selectionAgent =
		explicitAgent ?? registry?.defaultAgentId ?? agentIdSchema.parse("build");
	const selectionCandidate = candidateAgent(registry, selectionAgent);
	const selectionCandidatePluginProviderOwner = currentAgentPluginProviderOwner(
		{
			candidate: selectionCandidate,
			pluginRuntime,
			restoredModel: undefined,
		}
	);
	const explicitPluginProviderOwner =
		explicitModel === undefined ||
		providerModel.pluginProviderSource === undefined
			? undefined
			: {
					providerId: providerModel.providerId,
					...providerModel.pluginProviderSource,
				};
	return resolveSelection({
		agentOption: context.invocation.agent,
		availableProviderModels,
		knownProviderModels,
		thinkingLevelOption: context.invocation.thinkingLevel,
		modelOption: context.invocation.model,
		candidatePluginProviderOwner: selectionCandidatePluginProviderOwner,
		explicitPluginProviderOwner,
		registry,
		restored: null,
	});
};

const resolveOpenedOneShotSelection = async (
	context: ApplicationContext,
	host: SessionHost,
	preflight: OneShotHostPreflight
): Promise<ResolvedSelection> => {
	const {
		explicitAgent,
		explicitModel,
		pluginRuntime,
		providerModel,
		registry,
	} = preflight;
	const restored = host.getSelection();
	const explicitPluginProviderOwner =
		explicitModel === undefined
			? undefined
			: host.providerController?.getPluginProviderComposition?.(
					explicitModel.providerId
				)?.registration;
	const selectionAgent =
		explicitAgent ??
		restored?.agent ??
		registry?.defaultAgentId ??
		agentIdSchema.parse("build");
	const selectionCandidate = candidateAgent(registry, selectionAgent);
	const selectionCandidatePluginProviderOwner = currentAgentPluginProviderOwner(
		{
			candidate: selectionCandidate,
			pluginRuntime,
			restoredModel: explicitAgent === undefined ? restored?.model : undefined,
		}
	);
	const availableProviderModels =
		await host.providerController?.getAvailableModels(providerModel.providerId);
	const knownProviderModels = host.providerCollection?.getModels();
	return resolveSelection({
		agentOption: context.invocation.agent,
		availableProviderModels,
		knownProviderModels,
		thinkingLevelOption: context.invocation.thinkingLevel,
		modelOption: context.invocation.model,
		candidatePluginProviderOwner: selectionCandidatePluginProviderOwner,
		explicitPluginProviderOwner,
		registry,
		restored: explicitAgent === undefined ? restored : null,
	});
};

const openOneShotSessionHost = async ({
	capabilities,
	executionMode,
	manager,
	providerCollection,
	providerModel,
	sessionId,
}: Readonly<{
	capabilities: SessionServices["capabilities"];
	executionMode: OneShotFormat;
	manager: SessionHostManager;
	providerCollection?: ProviderCollection;
	providerModel: ProviderModelSelection;
	sessionId: SessionId;
}>): Promise<SessionHost> =>
	manager.openHost({
		capabilities,
		executionMode,
		...(providerCollection === undefined ? {} : { providerCollection }),
		providerModel,
		sessionId,
		view: true,
	});

const runOneShot = async (
	context: ApplicationContext,
	format: OneShotFormat,
	dependencies: OneShotDependencies = {}
): Promise<OneShotResult> => {
	const text = await readSubmission(context);
	const workspace = resolveWorkspaceRoot(context.cwd);
	const compose = dependencies.composeServices ?? composeDefaultServices;
	const oneShotComposition = await composeOneShotServices(
		context,
		workspace,
		compose
	);
	const { services } = oneShotComposition;
	let host: SessionHost | undefined;
	let manager: SessionHostManager | undefined;
	let pendingProviderCollection: ProviderCollection | undefined;
	let sessionId: SessionId | undefined;
	let isNewSession = false;
	let submissionAttempted = false;
	let removeEventListener: (() => void) | undefined;
	let terminalFailureMessage: string | undefined;
	let terminalSucceeded = false;
	try {
		const preflightSessionId =
			context.invocation.session === undefined
				? undefined
				: toSessionId(context.invocation.session);
		const plannedSessionId = plannedSessionIdForOneShot(preflightSessionId);
		const preflight = await preflightOneShotHost(
			context,
			services,
			preflightSessionId,
			plannedSessionId
		);
		pendingProviderCollection = preflight.providerCollection;
		const { providerCollection, providerModel } = preflight;
		let selection: ResolvedSelection | undefined =
			preflightSessionId === undefined
				? await resolveFreshOneShotSelection(context, preflight)
				: undefined;
		const initializedSession = await initializeOneShotSession(
			context,
			services,
			plannedSessionId
		);
		sessionId = initializedSession.sessionId;
		isNewSession = initializedSession.isNewSession;
		const sessionHostManager = services.capabilities.getSessionHostManager();
		manager = sessionHostManager;
		pendingProviderCollection = undefined;
		host = await openOneShotSessionHost({
			capabilities: services.capabilities,
			executionMode: format,
			manager: sessionHostManager,
			providerCollection,
			providerModel,
			sessionId,
		});
		assertPluginProviderSelectionOwner(
			providerModel,
			services.capabilities,
			host.providerCollection,
			sessionId
		);
		selection ??= await resolveOpenedOneShotSelection(context, host, preflight);
		removeEventListener = sessionHostManager.onEvent((managedEvent) => {
			if (managedEvent.type !== "agent-turn-event") {
				return;
			}
			const { event } = managedEvent;
			const isParentEvent = managedEvent.sessionId === sessionId;
			if (
				isParentEvent &&
				(event.type === "agent-turn-completed" ||
					event.type === "agent-turn-failed" ||
					event.type === "agent-turn-cancelled" ||
					event.type === "agent-turn-interrupted")
			) {
				if (event.type === "agent-turn-completed") {
					terminalSucceeded = true;
				} else {
					terminalSucceeded = false;
					terminalFailureMessage = event.failure.message;
				}
			}
			if (format === "json") {
				emitJsonEvent(
					context,
					event,
					isParentEvent ? undefined : managedEvent.sessionId
				);
			} else if (isParentEvent && event.type === "text-delta") {
				context.stdout.write(event.delta);
			}
		});
		const abort = () => host?.agentSession.cancel();
		context.signal?.addEventListener("abort", abort, { once: true });
		try {
			submissionAttempted = true;
			const outcome = await host.agentSession.send(
				sendInputFor(selection, text)
			);
			if (outcome.rejected) {
				throw new Error(outcome.reason);
			}
			await services.waitForBackgroundWork(sessionId);
			if (!terminalSucceeded) {
				if (format === "json" && terminalFailureMessage !== undefined) {
					return { terminalFailureMessage, terminalSucceeded: false };
				}
				throw new Error(
					terminalFailureMessage ?? "Agent Turn did not complete."
				);
			}
		} finally {
			context.signal?.removeEventListener("abort", abort);
		}
		return { terminalSucceeded };
	} finally {
		await pendingProviderCollection?.close().catch(() => undefined);
		removeEventListener?.();
		try {
			if (manager !== undefined && sessionId !== undefined) {
				await manager.releaseView(sessionId);
			}
		} finally {
			try {
				if (isNewSession && !submissionAttempted && sessionId !== undefined) {
					await services.store.deleteSession(sessionId);
				}
			} finally {
				await services.shutdown();
			}
		}
	}
};

export const runPrintMode = async (
	context: ApplicationContext,
	dependencies?: OneShotDependencies
): Promise<number> => {
	try {
		const result = await runOneShot(context, "print", dependencies);
		return result.terminalSucceeded ? 0 : 1;
	} catch (error) {
		context.stderr.write(
			`error: ${getErrorMessage(error, "Print Mode failed.")}\n`
		);
		return 1;
	}
};

export const runJsonMode = async (
	context: ApplicationContext,
	dependencies?: OneShotDependencies
): Promise<number> => {
	try {
		const result = await runOneShot(context, "json", dependencies);
		if (
			!result.terminalSucceeded &&
			result.terminalFailureMessage !== undefined
		) {
			context.stderr.write(`error: ${result.terminalFailureMessage}\n`);
		}
		return result.terminalSucceeded ? 0 : 1;
	} catch (error) {
		const message = getErrorMessage(error, "JSON Mode failed.");
		context.stdout.write(`${JSON.stringify({ error: message })}\n`);
		context.stderr.write(`error: ${message}\n`);
		return 1;
	}
};

export type {
	OneShotComposition,
	OneShotCompositionInput,
	OneShotDependencies,
};
