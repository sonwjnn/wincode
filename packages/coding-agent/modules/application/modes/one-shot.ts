import {
	type AgentId,
	type AgentTurnEvent,
	agentIdSchema,
} from "@wincode/agent-core";
import type { Connections } from "@wincode/ai/connections";
import {
	defaultChatModelSelection,
	findSupportedChatModel,
	normalizeThinkingLevel,
	normalizeThinkingSelection,
	parseCatalogModelSelection,
	type ThinkingLevel,
	type ThinkingSelection,
	thinkingLevelSchema,
} from "@wincode/ai/models";
import type { ProviderModel } from "@wincode/ai/sdk";
import { getErrorMessage, omitUndefined } from "@wincode/utils";
import {
	type AgentSelectionOverride,
	resolveEffectiveAgentSelection,
	withAvailableAgentModelOverride,
} from "@/modules/agents/agent-call";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import {
	catalogSelectionForProviderModel,
	isAvailableProviderModelSelection,
	normalizeProviderModelSelection,
	normalizeProviderModelThinkingSelection,
	type ProviderModelSelection,
	parseProviderModelSelection,
} from "@/modules/providers/provider-model-selection";
import { resolveWorkspaceRoot } from "@/modules/tools";
import type { ConfigRuntime } from "@/shared/config/config-store";
import type { AgentRegistry } from "../../../modules/agents/registry";
import type { SessionServices } from "../../../modules/sessions/host/session-services";
import type {
	SessionHost,
	SessionHostManager,
} from "../../../modules/sessions/host/types";
import type { ResolvedSessionSelection } from "../../../modules/sessions/selection";
import type { SessionSendInput } from "../../../modules/sessions/submission-types";
import { type SessionId, toSessionId } from "../../../shared/identifiers";
import { resolveChatModelAvailability } from "../chat-model-availability";
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
	const catalogCandidate = value.includes("/")
		? parseCatalogModelSelection(value)
		: (() => {
				const entry = findSupportedChatModel(value);
				return entry === null
					? null
					: {
							modelId: entry.id,
							providerId: entry.connectionProviderId,
						};
			})();
	const candidate = catalogCandidate ?? parseProviderModelSelection(value);
	const parsed = normalizeProviderModelSelection(candidate);
	if (parsed === null) {
		throw new InvocationError(`Invalid Model selector: ${value}`);
	}
	return parsed;
};

const validateModelAvailability = async (
	model: ProviderModelSelection,
	connections: Connections
): Promise<void> => {
	const catalogModel = catalogSelectionForProviderModel(model);
	if (catalogModel === null) {
		throw new InvocationError(
			`Provider Model ${model.providerId}/${model.modelId} requires the Provider SDK runtime.`
		);
	}
	const availability = await resolveChatModelAvailability(
		catalogModel,
		connections
	);
	if (availability.status === "available") {
		return;
	}
	if (availability.status === "disconnected") {
		throw new InvocationError(
			`Connect ${model.providerId} to use Model ${model.modelId}.`
		);
	}
	if (availability.status === "retired") {
		throw new InvocationError(
			`Model ${model.providerId}/${model.modelId} is retired.`
		);
	}
	throw new InvocationError(
		`Invalid Model selector: ${model.providerId}/${model.modelId}`
	);
};

const candidateAgent = (
	registry: AgentRegistry | null,
	agent: AgentId
): AgentRegistry["agents"][number] | undefined =>
	registry?.agents.find((candidate) => candidate.id === agent);

const resolvedAgentFor = (
	candidate: AgentRegistry["agents"][number] | undefined
): SessionSendInput["resolvedAgent"] =>
	candidate === undefined
		? undefined
		: {
				id: candidate.id,
				instructions: candidate.instructions,
				role: candidate.role,
				visibleCodingTools: [...candidate.visibleCodingTools],
			};

const resolveExplicitThinkingLevel = (
	model: ProviderModelSelection,
	value: string,
	providerModel: ProviderModel | undefined
): ThinkingLevel => {
	const parsed = thinkingLevelSchema.safeParse(value);
	if (!parsed.success) {
		throw new InvocationError(`Invalid --thinking-level value: ${value}`);
	}
	if (providerModel !== undefined) {
		const normalized = normalizeProviderModelThinkingSelection(providerModel, {
			thinkingLevel: parsed.data,
		});
		if (normalized.thinkingLevel !== parsed.data) {
			throw new InvocationError(`Invalid --thinking-level value: ${value}`);
		}
		return parsed.data;
	}
	const catalogModel = catalogSelectionForProviderModel(model);
	const thinkingLevel =
		catalogModel === null
			? undefined
			: normalizeThinkingLevel(catalogModel, value);
	if (thinkingLevel === undefined) {
		throw new InvocationError(`Invalid --thinking-level value: ${value}`);
	}
	return thinkingLevel;
};

type ResolvedOneShotModel = Readonly<{
	agent: AgentId;
	model: ProviderModelSelection;
	providerModel?: ProviderModel;
	selectionOverride?: AgentSelectionOverride;
	resolvedAgent?: SessionSendInput["resolvedAgent"];
}>;

const isSameModelIdentity = (
	left: Readonly<{ modelId: string; providerId: string }>,
	right: Readonly<{ modelId: string; providerId: string }>
): boolean =>
	left.providerId === right.providerId && left.modelId === right.modelId;

const resolveOneShotModel = ({
	agent,
	availableProviderModels,
	candidate,
	explicitModel,
	registry,
	restored,
}: {
	agent: AgentId;
	availableProviderModels?: readonly ProviderModel[];
	candidate: AgentRegistry["agents"][number] | undefined;
	explicitModel: ProviderModelSelection | undefined;
	registry: AgentRegistry | null;
	restored: ResolvedSessionSelection | null;
}): ResolvedOneShotModel => {
	const restoredModel = restored?.model;
	const model =
		explicitModel ??
		restoredModel ??
		candidate?.model ??
		defaultChatModelSelection;
	if (availableProviderModels === undefined) {
		if (catalogSelectionForProviderModel(model) === null) {
			throw new InvocationError(
				`Provider Model ${model.providerId}/${model.modelId} requires the Provider SDK runtime.`
			);
		}
		return { agent, model, resolvedAgent: resolvedAgentFor(candidate) };
	}
	const providerModel = availableProviderModels.find((available) =>
		isSameModelIdentity(available, model)
	);
	if (providerModel === undefined) {
		throw new InvocationError(
			`Provider Model ${model.providerId}/${model.modelId} is unavailable in this One-Shot Host.`
		);
	}
	const explicitModelOverride =
		explicitModel !== undefined ||
		(restoredModel !== undefined &&
			(candidate?.model === undefined ||
				!isSameModelIdentity(candidate.model, restoredModel)))
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
		isSameModelIdentity(available, effective.model)
	);
	return {
		agent: effective.agent,
		model: effective.model,
		resolvedAgent: effective.resolvedAgent,
		...(selectionOverride === undefined ? {} : { selectionOverride }),
		...(effectiveProviderModel === undefined
			? {}
			: { providerModel: effectiveProviderModel }),
	};
};

const resolveSelection = ({
	agentOption,
	availableProviderModels,
	thinkingLevelOption,
	modelOption,
	restored,
	registry,
}: {
	agentOption: string | undefined;
	availableProviderModels?: readonly ProviderModel[];
	thinkingLevelOption: string | undefined;
	modelOption: string | undefined;
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
		candidate,
		explicitModel,
		registry,
		restored,
	});
	const thinkingChoice =
		thinkingLevelOption === undefined
			? (restored?.thinkingLevel ??
				candidate?.thinkingLevel ??
				DEFAULT_THINKING_LEVEL)
			: resolveExplicitThinkingLevel(
					effective.model,
					thinkingLevelOption,
					effective.providerModel
				);
	const selection =
		effective.providerModel === undefined
			? normalizeThinkingSelection(
					catalogSelectionForProviderModel(effective.model) ??
						defaultChatModelSelection,
					{ thinkingLevel: thinkingChoice }
				)
			: normalizeProviderModelThinkingSelection(effective.providerModel, {
					thinkingLevel: thinkingChoice,
				});
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
const initializeOneShotSession = async (
	context: ApplicationContext,
	services: SessionServices
): Promise<{ isNewSession: boolean; sessionId: SessionId }> => {
	const existingSessionId =
		context.invocation.session === undefined
			? undefined
			: toSessionId(context.invocation.session);
	if (existingSessionId !== undefined) {
		return { isNewSession: false, sessionId: existingSessionId };
	}
	const created = await services.store.createEmptySession({});
	return { isNewSession: true, sessionId: created.id };
};

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
	let sessionId: SessionId | undefined;
	let isNewSession = false;
	let submissionAttempted = false;
	let removeEventListener: (() => void) | undefined;
	let terminalFailureMessage: string | undefined;
	let terminalSucceeded = false;
	try {
		const initializedSession = await initializeOneShotSession(
			context,
			services
		);
		sessionId = initializedSession.sessionId;
		isNewSession = initializedSession.isNewSession;
		const sessionHostManager = services.capabilities.getSessionHostManager();
		manager = sessionHostManager;
		host = await sessionHostManager.openHost({
			capabilities: services.capabilities,
			executionMode: format,
			sessionId,
			view: true,
		});
		const registry = services.capabilities.getRegistry();
		const restored = host.getSelection();
		const availableProviderModels =
			await host.providerController?.getAvailableModels();
		const selection = resolveSelection({
			agentOption: context.invocation.agent,
			availableProviderModels,
			thinkingLevelOption: context.invocation.thinkingLevel,
			modelOption: context.invocation.model,
			registry,
			restored,
		});
		if (availableProviderModels === undefined) {
			await validateModelAvailability(
				selection.model,
				services.capabilities.getConnections()
			);
		}
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
