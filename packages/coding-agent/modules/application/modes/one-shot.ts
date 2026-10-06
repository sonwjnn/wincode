import {
	type AgentId,
	type AgentTurnEvent,
	agentIdSchema,
	createAgentTurnId,
} from "@wincode/agent-core";
import type { Connections } from "@wincode/ai/connections";
import {
	type ChatModelSelection,
	createReasoningSelection,
	defaultChatModelSelection,
	type Effort,
	findSupportedChatModel,
	findSupportedChatModelSelection,
	isActiveChatModel,
	modelSelectionSchema,
	normalizeModelEffort,
	normalizeReasoningMode,
	normalizeReasoningSelection,
	parseCatalogModelSelection,
	type ReasoningMode,
	type ReasoningSelection,
} from "@wincode/ai/models";
import { getErrorMessage } from "@wincode/utils";
import { resolveWorkspaceRoot } from "@/modules/tools";
import type { AgentRegistry } from "../../../modules/agents/registry";
import { createPermissionService } from "../../../modules/permissions/permission-service";
import type { DelegationTask } from "../../../modules/sessions/delegation/types";
import type { SessionCapabilitiesAssembly } from "../../../modules/sessions/host/session-capabilities";
import { createSessionCapabilities } from "../../../modules/sessions/host/session-capabilities";
import type {
	SessionHost,
	SessionHostManager,
	SessionHostManagerEvent,
} from "../../../modules/sessions/host/types";
import type { SessionMessage } from "../../../modules/sessions/message";
import { createSessionUserMessage } from "../../../modules/sessions/message";
import type { ResolvedSessionSelection } from "../../../modules/sessions/selection";
import type { SessionSendInput } from "../../../modules/sessions/submission-types";
import { type SessionId, toSessionId } from "../../../shared/identifiers";
import { projectAgentEvent } from "../rpc/projection";
import type { ApplicationContext } from "./types";
import { InvocationError } from "./types";

type OneShotFormat = "json" | "print";

type OneShotCompositionInput = Readonly<{
	autoApproval: boolean;
	cwd: string;
	workspace: string;
}>;

type OneShotDependencies = Readonly<{
	composeCapabilities?: (
		input: OneShotCompositionInput
	) => Promise<SessionCapabilitiesAssembly>;
}>;

type ResolvedSelection = Readonly<{
	agent: AgentId;
	model: ChatModelSelection;
	resolvedAgent?: SessionSendInput["resolvedAgent"];
}> &
	ReasoningSelection;

type OneShotResult = Readonly<{
	terminalFailureMessage?: string;
	terminalSucceeded: boolean;
}>;

const DEFAULT_EFFORT = "low";

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
	const catalogModel = findSupportedChatModelSelection(model);
	if (catalogModel === null) {
		throw new InvocationError(
			`Invalid Model selector: ${model.providerId}/${model.modelId}`
		);
	}
	if (!isActiveChatModel(catalogModel)) {
		throw new InvocationError(
			`Model ${model.providerId}/${model.modelId} is retired.`
		);
	}
	const provider = (await connections.listProviders()).find(
		(candidate) => candidate.id === model.providerId
	);
	if (provider?.connected !== true) {
		throw new InvocationError(
			`Connect ${model.providerId} to use Model ${model.modelId}.`
		);
	}
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
				...(candidate.requiresManualApproval
					? { requiresManualApproval: true }
					: {}),
				visibleCodingTools: [...candidate.visibleCodingTools],
			};

const resolveExplicitEffort = (
	model: ChatModelSelection,
	value: string
): Effort => {
	const effort = normalizeModelEffort(model, value);
	if (effort === undefined) {
		throw new InvocationError(`Invalid --effort value: ${value}`);
	}
	return effort;
};

const resolveExplicitReasoningMode = (
	model: ChatModelSelection,
	value: string
): ReasoningMode => {
	const reasoningMode = normalizeReasoningMode(model, value);
	if (reasoningMode === undefined) {
		throw new InvocationError(`Invalid --reasoning-mode value: ${value}`);
	}
	return reasoningMode;
};

const resolveSelection = ({
	agentOption,
	effortOption,
	modelOption,
	restored,
	registry,
	reasoningModeOption,
}: {
	agentOption: string | undefined;
	effortOption: string | undefined;
	modelOption: string | undefined;
	registry: AgentRegistry | null;
	restored: ResolvedSessionSelection | null;
	reasoningModeOption: string | undefined;
}): ResolvedSelection => {
	if (effortOption !== undefined && reasoningModeOption !== undefined) {
		throw new InvocationError(
			"Use either --effort or --reasoning-mode, not both.",
			2
		);
	}
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
	let explicitChoice: ReasoningSelection | undefined;
	if (effortOption !== undefined) {
		explicitChoice = createReasoningSelection(
			resolveExplicitEffort(model, effortOption),
			undefined
		);
	} else if (reasoningModeOption !== undefined) {
		explicitChoice = createReasoningSelection(
			undefined,
			resolveExplicitReasoningMode(model, reasoningModeOption)
		);
	}
	const restoredChoice =
		restored?.effort === undefined && restored?.reasoningMode === undefined
			? undefined
			: createReasoningSelection(restored?.effort, restored?.reasoningMode);
	const candidateChoice =
		candidate?.effort === undefined && candidate?.reasoningMode === undefined
			? undefined
			: createReasoningSelection(candidate?.effort, candidate?.reasoningMode);
	const defaultEffort = normalizeModelEffort(model, DEFAULT_EFFORT);
	const defaultChoice = createReasoningSelection(defaultEffort, undefined);
	const selection = normalizeReasoningSelection(
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

const composeDefaultCapabilities = async ({
	autoApproval,
	cwd,
	workspace,
}: OneShotCompositionInput): Promise<SessionCapabilitiesAssembly> =>
	createSessionCapabilities({
		approvalMode: "non-interactive",
		cwd,
		permissionService: createPermissionService({ autoApproval }),
		workspace,
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
	...(selection.effort === undefined
		? {}
		: { effort: selection.effort, sessionEffort: selection.effort }),
	...(selection.reasoningMode === undefined
		? {}
		: {
				reasoningMode: selection.reasoningMode,
				sessionReasoningMode: selection.reasoningMode,
			}),
	...(message === undefined ? { userText: text } : { messageId: message.id }),
});

const emitJsonEvent = (
	context: ApplicationContext,
	event: AgentTurnEvent
): void => {
	context.stdout.write(`${JSON.stringify(projectAgentEvent(event))}\n`);
};
const emitJsonManagerEvent = (
	context: ApplicationContext,
	event: SessionHostManagerEvent
): void => {
	if (event.type === "session-approval-notice") {
		return;
	}
	const projected =
		event.type === "agent-turn-event"
			? {
					event: projectAgentEvent(event.event),
					sessionId: event.sessionId,
					type: "delegated-agent-turn-event",
				}
			: {
					...(event.report === undefined ? {} : { report: event.report }),
					task: event.task,
					type: "delegation-task",
				};
	context.stdout.write(`${JSON.stringify(projected)}\n`);
};
const initializeOneShotSession = async (
	context: ApplicationContext,
	assembly: SessionCapabilitiesAssembly,
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
		const registry = assembly.capabilities.getRegistry();
		const selection = resolveSelection({
			agentOption: context.invocation.agent,
			effortOption: context.invocation.effort,
			modelOption: context.invocation.model,
			registry,
			restored: null,
			reasoningModeOption: context.invocation.reasoningMode,
		});
		await validateModelAvailability(
			selection.model,
			assembly.capabilities.getConnections()
		);
		initialMessage = createSessionUserMessage(text, {
			agent: selection.agent,
			model: selection.model,
			...(selection.effort === undefined ? {} : { effort: selection.effort }),
			...(selection.reasoningMode === undefined
				? {}
				: { reasoningMode: selection.reasoningMode }),
		});
		const [durableMessage] = await assembly.store.externalizeAttachments(
			[initialMessage],
			undefined,
			{ rejectInvalid: true }
		);
		const created = await assembly.store.createSession({
			agent: selection.agent,
			message: durableMessage ?? initialMessage,
			model: selection.model,
			turnId: createAgentTurnId(),
			...(selection.effort === undefined ? {} : { effort: selection.effort }),
			...(selection.reasoningMode === undefined
				? {}
				: { reasoningMode: selection.reasoningMode }),
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
	const compose =
		dependencies.composeCapabilities ?? composeDefaultCapabilities;
	const assembly = await compose({
		autoApproval: context.invocation.auto,
		cwd: context.cwd,
		workspace,
	});
	let host: SessionHost | undefined;
	let manager: SessionHostManager | undefined;
	let removeEventListener: (() => void) | undefined;
	let removeManagerEventListener: (() => void) | undefined;
	let terminalFailureMessage: string | undefined;
	let terminalSucceeded = false;
	try {
		const { initialMessage, sessionId } = await initializeOneShotSession(
			context,
			assembly,
			text
		);
		manager = assembly.capabilities.getSessionHostManager();
		host = await manager.openHost({
			capabilities: assembly.capabilities,
			executionMode: format,
			sessionId,
		});
		const registry = assembly.capabilities.getRegistry();
		const restored = host.getSelection();
		const selection = resolveSelection({
			agentOption: context.invocation.agent,
			effortOption: context.invocation.effort,
			modelOption: context.invocation.model,
			registry,
			restored,
			reasoningModeOption: context.invocation.reasoningMode,
		});
		const taskSessions = new Set<SessionId>([sessionId]);
		const seenTaskStatuses = new Map<
			DelegationTask["id"],
			DelegationTask["status"]
		>();
		if (format === "json") {
			removeManagerEventListener = manager.onEvent((event) => {
				if (
					event.type === "agent-turn-event" &&
					event.sessionId !== sessionId &&
					taskSessions.has(event.sessionId)
				) {
					emitJsonManagerEvent(context, event);
					return;
				}
				if (
					event.type === "delegation-task" &&
					taskSessions.has(event.task.parentSessionId)
				) {
					taskSessions.add(event.task.childSessionId);
					seenTaskStatuses.set(event.task.id, event.task.status);
					emitJsonManagerEvent(context, event);
				}
			});
		}
		removeEventListener = host.onEvent((event) => {
			if (
				event.type === "agent-turn-completed" ||
				event.type === "agent-turn-failed" ||
				event.type === "agent-turn-cancelled" ||
				event.type === "agent-turn-interrupted"
			) {
				if (event.type === "agent-turn-completed") {
					terminalSucceeded = true;
				} else {
					terminalSucceeded = false;
					terminalFailureMessage = event.failure.message;
				}
			}
			if (format === "json") {
				emitJsonEvent(context, event);
			} else if (event.type === "text-delta") {
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
			const tasks = await manager.delegation.waitForTasks(
				assembly.store,
				sessionId
			);
			for (const task of tasks) {
				if (seenTaskStatuses.get(task.id) !== task.status) {
					seenTaskStatuses.set(task.id, task.status);
					taskSessions.add(task.childSessionId);
					if (format === "json") {
						emitJsonManagerEvent(context, {
							task,
							type: "delegation-task",
						});
					}
				}
			}
			const unfinishedTask = tasks.find((task) => task.status !== "succeeded");
			if (unfinishedTask !== undefined) {
				terminalSucceeded = false;
				terminalFailureMessage =
					unfinishedTask.status === "awaiting_report"
						? `Delegation Task ${unfinishedTask.id} is awaiting_report. One-Shot mode will not continue the parent Session automatically; submit its report explicitly.`
						: `Delegation Task ${unfinishedTask.id} ended with status '${unfinishedTask.status}'.`;
			}
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
		removeManagerEventListener?.();
		await assembly.shutdown();
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

export type { OneShotCompositionInput, OneShotDependencies };
