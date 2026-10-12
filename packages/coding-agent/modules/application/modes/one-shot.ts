import {
	type AgentId,
	type AgentTurnEvent,
	agentIdSchema,
	createAgentTurnId,
} from "@wincode/agent-core";
import type { Connections } from "@wincode/ai/connections";
import {
	type ChatModelSelection,
	defaultChatModelSelection,
	findSupportedChatModel,
	modelSelectionSchema,
	normalizeThinkingLevel,
	normalizeThinkingSelection,
	parseCatalogModelSelection,
	type ThinkingLevel,
	type ThinkingSelection,
} from "@wincode/ai/models";
import { getErrorMessage, omitUndefined } from "@wincode/utils";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import { resolveWorkspaceRoot } from "@/modules/tools";
import type { ConfigRuntime } from "@/shared/config/config-store";
import type { AgentRegistry } from "../../../modules/agents/registry";
import type { SessionServices } from "../../../modules/sessions/host/session-services";
import type {
	SessionHost,
	SessionHostManager,
} from "../../../modules/sessions/host/types";
import type { SessionMessage } from "../../../modules/sessions/message";
import { createSessionUserMessage } from "../../../modules/sessions/message";
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
	composeEnvironment?: (
		input: OneShotCompositionInput
	) => Promise<OneShotComposition>;
}>;

const composeOneShotEnvironment = async (
	context: ApplicationContext,
	workspace: string,
	compose: NonNullable<OneShotDependencies["composeEnvironment"]>
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
	model: ChatModelSelection;
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
): ChatModelSelection | undefined => {
	if (value === undefined) {
		return;
	}
	const candidate = value.includes("/")
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
	if (candidate === null) {
		throw new InvocationError(`Invalid Model selector: ${value}`);
	}
	const parsed = modelSelectionSchema.safeParse(candidate);
	if (!parsed.success) {
		throw new InvocationError(`Invalid Model selector: ${value}`);
	}
	return parsed.data;
};

const validateModelAvailability = async (
	model: ChatModelSelection,
	connections: Connections
): Promise<void> => {
	const availability = await resolveChatModelAvailability(model, connections);
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
	registry?.selectableAgents.find(
		(candidate) => candidate.id === agent && candidate.isAvailable
	);

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
	model: ChatModelSelection,
	value: string
): ThinkingLevel => {
	const thinkingLevel = normalizeThinkingLevel(model, value);
	if (thinkingLevel === undefined) {
		throw new InvocationError(`Invalid --thinking-level value: ${value}`);
	}
	return thinkingLevel;
};

const resolveSelection = ({
	agentOption,
	thinkingLevelOption,
	modelOption,
	restored,
	registry,
}: {
	agentOption: string | undefined;
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

	const model =
		explicitModel ??
		restored?.model ??
		candidate?.model ??
		defaultChatModelSelection;
	const explicitChoice =
		thinkingLevelOption === undefined
			? undefined
			: {
					thinkingLevel: resolveExplicitThinkingLevel(
						model,
						thinkingLevelOption
					),
				};
	const restoredChoice =
		restored?.thinkingLevel === undefined
			? undefined
			: { thinkingLevel: restored.thinkingLevel };
	const candidateChoice =
		candidate?.thinkingLevel === undefined
			? undefined
			: { thinkingLevel: candidate.thinkingLevel };
	const defaultChoice = { thinkingLevel: DEFAULT_THINKING_LEVEL };
	const selection = normalizeThinkingSelection(
		model,
		explicitChoice ?? restoredChoice ?? candidateChoice ?? defaultChoice
	);
	return {
		agent,
		model,
		resolvedAgent: resolvedAgentFor(candidate),
		...selection,
	};
};

const composeDefaultEnvironment = async ({
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
	text: string,
	message: SessionMessage | undefined
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
	...(message === undefined ? { userText: text } : { messageId: message.id }),
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
	services: SessionServices,
	text: string
): Promise<{
	initialMessage: SessionMessage | undefined;
	sessionId: SessionId;
}> => {
	let initialMessage: SessionMessage | undefined;
	let sessionId =
		context.invocation.session === undefined
			? undefined
			: toSessionId(context.invocation.session);
	if (sessionId === undefined) {
		const registry = services.capabilities.getRegistry();
		const selection = resolveSelection({
			agentOption: context.invocation.agent,
			thinkingLevelOption: context.invocation.thinkingLevel,
			modelOption: context.invocation.model,
			registry,
			restored: null,
		});
		await validateModelAvailability(
			selection.model,
			services.capabilities.getConnections()
		);
		initialMessage = createSessionUserMessage(text, {
			agent: selection.agent,
			model: selection.model,
			...(selection.thinkingLevel === undefined
				? {}
				: { thinkingLevel: selection.thinkingLevel }),
		});
		const [durableMessage] = await services.store.externalizeAttachments(
			[initialMessage],
			undefined,
			{ rejectInvalid: true }
		);
		const created = await services.store.createSession({
			agent: selection.agent,
			message: durableMessage ?? initialMessage,
			model: selection.model,
			turnId: createAgentTurnId(),
			...(selection.thinkingLevel === undefined
				? {}
				: { thinkingLevel: selection.thinkingLevel }),
		});
		sessionId = created.id;
	}
	if (sessionId === undefined) {
		throw new Error("One-Shot Session creation did not return an ID.");
	}
	return { initialMessage, sessionId };
};

const runOneShot = async (
	context: ApplicationContext,
	format: OneShotFormat,
	dependencies: OneShotDependencies = {}
): Promise<OneShotResult> => {
	const text = await readSubmission(context);
	const workspace = resolveWorkspaceRoot(context.cwd);
	const compose = dependencies.composeEnvironment ?? composeDefaultEnvironment;
	const oneShotComposition = await composeOneShotEnvironment(
		context,
		workspace,
		compose
	);
	const { services } = oneShotComposition;
	let host: SessionHost | undefined;
	let manager: SessionHostManager | undefined;
	let sessionId: SessionId | undefined;
	let removeEventListener: (() => void) | undefined;
	let terminalFailureMessage: string | undefined;
	let terminalSucceeded = false;
	try {
		const initializedSession = await initializeOneShotSession(
			context,
			services,
			text
		);
		sessionId = initializedSession.sessionId;
		const sessionHostManager = services.capabilities.getSessionHostManager();
		manager = sessionHostManager;
		host = await sessionHostManager.openHost({
			capabilities: services.capabilities,
			executionMode: format,
			sessionId,
			view: true,
		});
		const { initialMessage } = initializedSession;
		const registry = services.capabilities.getRegistry();
		const restored = host.getSelection();
		const selection = resolveSelection({
			agentOption: context.invocation.agent,
			thinkingLevelOption: context.invocation.thinkingLevel,
			modelOption: context.invocation.model,
			registry,
			restored,
		});
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
			const outcome = await host.agentSession.send(
				sendInputFor(selection, text, initialMessage)
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
			await services.shutdown();
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
