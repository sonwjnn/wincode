import {
	type AgentId,
	type AgentTurnEvent,
	agentIdSchema,
	createAgentTurnId,
} from "@wincode/agent-core";
import {
	type ChatModelSelection,
	defaultChatModelSelection,
	findSupportedChatModel,
	type ModelVariant,
	modelSelectionSchema,
	normalizeModelVariant,
	parseCatalogModelSelection,
} from "@wincode/ai/models";
import { resolveWorkspaceRoot } from "@wincode/coding-tools/workspace";
import { getErrorMessage } from "@wincode/runtime-utils";
import type { AgentRegistry } from "../../../modules/agents/registry";
import { createPermissionService } from "../../../modules/permissions/permission-service";
import type { SessionCapabilitiesAssembly } from "../../../modules/sessions/host/session-capabilities";
import { createSessionCapabilities } from "../../../modules/sessions/host/session-capabilities";
import { createSessionHost } from "../../../modules/sessions/host/session-host";
import type { SessionHost } from "../../../modules/sessions/host/types";
import type { SessionMessage } from "../../../modules/sessions/message";
import { createSessionUserMessage } from "../../../modules/sessions/message";
import type { ResolvedSessionSelection } from "../../../modules/sessions/selection";
import type { SessionSendInput } from "../../../modules/sessions/session-operation";
import { toSessionId } from "../../../shared/identifiers";
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
	variant?: ModelVariant;
}>;

type OneShotResult = Readonly<{
	terminalFailureMessage?: string;
	terminalSucceeded: boolean;
}>;

const DEFAULT_THINKING_LEVEL = "low";

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

const resolveVariant = (
	model: ChatModelSelection,
	value: string | undefined,
	explicit: boolean
): ModelVariant | undefined => {
	const variant = normalizeModelVariant(model, value);
	if (explicit && value !== undefined && variant === undefined) {
		throw new InvocationError(`Invalid Thinking Level selector: ${value}`);
	}
	return variant;
};
const resolveSelection = ({
	agentOption,
	modelOption,
	restored,
	registry,
	thinkingOption,
}: {
	agentOption: string | undefined;
	modelOption: string | undefined;
	registry: AgentRegistry | null;
	restored: ResolvedSessionSelection | null;
	thinkingOption: string | undefined;
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
	const restoredVariant = restored?.variant;
	const candidateVariant = candidate?.variant;
	const variant = resolveVariant(
		model,
		thinkingOption ??
			restoredVariant ??
			candidateVariant ??
			DEFAULT_THINKING_LEVEL,
		thinkingOption !== undefined
	);
	return {
		agent,
		model,
		resolvedAgent: resolvedAgentFor(candidate),
		...(variant === undefined ? {} : { variant }),
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
	...(selection.variant === undefined
		? {}
		: { sessionVariant: selection.variant, variant: selection.variant }),
	...(message === undefined ? { userText: text } : { messageId: message.id }),
});

const emitJsonEvent = (
	context: ApplicationContext,
	event: AgentTurnEvent
): void => {
	context.stdout.write(`${JSON.stringify(projectAgentEvent(event))}\n`);
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
	let removeEventListener: (() => void) | undefined;
	let removeFatalListener: (() => void) | undefined;
	let terminalFailureMessage: string | undefined;
	let terminalSucceeded = false;
	let leaseLost = false;
	try {
		const selectedSession = context.invocation.session;
		let initialMessage: SessionMessage | undefined;
		let sessionId =
			selectedSession === undefined ? undefined : toSessionId(selectedSession);
		let restored: ResolvedSessionSelection | null = null;
		if (sessionId === undefined) {
			const registry = assembly.capabilities.getRegistry();
			const selection = resolveSelection({
				agentOption: context.invocation.agent,
				modelOption: context.invocation.model,
				registry,
				restored: null,
				thinkingOption: context.invocation.thinking,
			});
			initialMessage = createSessionUserMessage(text, {
				agent: selection.agent,
				model: selection.model,
				...(selection.variant === undefined
					? {}
					: { variant: selection.variant }),
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
				...(selection.variant === undefined
					? {}
					: { variant: selection.variant }),
			});
			sessionId = created.id;
		}
		if (sessionId === undefined) {
			throw new Error("One-Shot Session creation did not return an ID.");
		}
		host = await createSessionHost({
			capabilities: assembly.capabilities,
			sessionId,
		});
		const registry = assembly.capabilities.getRegistry();
		restored = host.getSelection();
		const selection = resolveSelection({
			agentOption: context.invocation.agent,
			modelOption: context.invocation.model,
			registry,
			restored,
			thinkingOption: context.invocation.thinking,
		});
		removeFatalListener = host.onFatal((failure) => {
			if (failure.code === "session_lease_lost") {
				leaseLost = true;
			}
		});
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
		const abort = () => host?.engine.cancel();
		context.signal?.addEventListener("abort", abort, { once: true });
		try {
			const outcome = await host.engine.send(
				sendInputFor(selection, text, initialMessage)
			);
			if (outcome.rejected) {
				throw new Error(outcome.reason);
			}
			if (leaseLost) {
				throw new Error("Session lease lost during the Agent Turn.");
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
		removeFatalListener?.();
		await host?.shutdown();
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
