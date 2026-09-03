import type {
	AgentRuntime,
	AgentTurn,
	AgentTurnMessage,
} from "@wincode/agent-core";
import { createAiSdkTextOnlyAgentRuntime } from "@wincode/agent-runtime-ai-sdk";
import type {
	AgentId,
	CodingAgentUIMessage,
	McpToolManifest,
	ResolvedAgentRuntime,
} from "@wincode/ai";
import { getSystemInstructionsForAgent } from "@wincode/ai";
import type { ModelTarget } from "@wincode/ai/model-target";
import type { SkillRequestContext, SkillToolDefinition } from "@wincode/skills";
import type { UIMessageChunk } from "ai";

export type TextOnlyRuntimeFactory = () => AgentRuntime;

/** Composition-root default: the private AI SDK Agent Runtime adapter. */
export const defaultTextOnlyRuntimeFactory: TextOnlyRuntimeFactory = () =>
	createAiSdkTextOnlyAgentRuntime();

/**
 * Eligibility for the text-only Agent Runtime path at the conversation seam.
 *
 * A send is text-only when the resolved Agent exposes no coding tools
 * (permission filtering already hides unconditionally denied tools), no MCP
 * tools are available, no Skill is active, and the conversation carries no
 * tool, file, or data parts. Such a turn can never invoke a Tool, so running
 * it through the tool-less Agent Runtime instead of the legacy agent loop
 * cannot change visible behavior. Tool-armed sends keep the legacy path.
 */
export const isTextOnlyEligibleSend = ({
	mcpManifest,
	messages,
	resolvedAgent,
	skill,
	skillTool,
}: {
	mcpManifest: McpToolManifest;
	messages: readonly CodingAgentUIMessage[];
	resolvedAgent: ResolvedAgentRuntime | undefined;
	skill: SkillRequestContext | undefined;
	skillTool: SkillToolDefinition | undefined;
}): boolean => {
	if (!resolvedAgent || resolvedAgent.visibleCodingTools.length > 0) {
		return false;
	}
	// A body-bearing Skill on the newest user message is injected into the
	// model input by the legacy path even without an armed Skill tool; the
	// runtime path must not silently drop it.
	if (
		mcpManifest.length > 0 ||
		skill !== undefined ||
		skillTool !== undefined
	) {
		return false;
	}
	for (const message of messages) {
		if (message.metadata?.interrupted === true) {
			return false;
		}
		let hasText = false;
		for (const part of message.parts) {
			if (part.type === "text") {
				hasText = hasText || part.text.length > 0;
				continue;
			}
			if (part.type !== "step-start" && part.type !== "reasoning") {
				return false;
			}
		}
		// An assistant reply that streamed only reasoning would otherwise be
		// dropped from the runtime prompt, breaking role alternation with the
		// legacy path. Keep such conversations on the legacy path.
		if (message.role === "assistant" && !hasText) {
			return false;
		}
	}
	return true;
};

const toAgentTurnMessage = (
	message: CodingAgentUIMessage
): AgentTurnMessage | undefined => {
	if (message.role !== "assistant" && message.role !== "user") {
		return;
	}
	const parts = message.parts.flatMap((part) =>
		part.type === "text" && part.text.length > 0
			? [{ text: part.text, type: "text" as const }]
			: []
	);
	if (parts.length === 0) {
		return;
	}
	return { id: message.id, parts, role: message.role };
};

/**
 * Builds one text-only Agent Turn from the resolved conversation send. The
 * Model Target is resolved by the caller (it needs authorization); the Agent
 * instructions are composed the same way the legacy loop composes them.
 */
export const buildTextOnlyAgentTurn = ({
	agent,
	modelMessages,
	modelTarget,
	resolvedAgent,
	turnId,
}: {
	agent: AgentId;
	modelMessages: readonly CodingAgentUIMessage[];
	modelTarget: ModelTarget;
	resolvedAgent: ResolvedAgentRuntime;
	turnId: string;
}): AgentTurn => {
	const messages = modelMessages
		.map(toAgentTurnMessage)
		.filter((message): message is AgentTurnMessage => message !== undefined);
	return {
		agent: {
			id: agent,
			instructions: getSystemInstructionsForAgent(resolvedAgent.instructions),
			role: "primary",
		},
		id: turnId,
		input: { messages },
		model: modelTarget,
	};
};

const TEXT_CHUNK_ID = "text-1";
const REASONING_CHUNK_ID = "reasoning-1";

/**
 * Owns the open text/reasoning part state of one display chunk stream so a
 * terminal Agent Turn Event closes every part before the terminal chunk.
 */
const createPartWriter = (enqueue: (chunk: UIMessageChunk) => void) => {
	let reasoningOpen = false;
	let textOpen = false;

	const closeText = (): void => {
		if (!textOpen) {
			return;
		}
		textOpen = false;
		enqueue({ id: TEXT_CHUNK_ID, type: "text-end" });
	};
	const closeReasoning = (): void => {
		if (!reasoningOpen) {
			return;
		}
		reasoningOpen = false;
		enqueue({ id: REASONING_CHUNK_ID, type: "reasoning-end" });
	};
	const closeParts = (): void => {
		closeText();
		closeReasoning();
	};

	const openStep = (): void => {
		enqueue({ type: "start-step" });
	};
	const textDelta = (delta: string): void => {
		if (!textOpen) {
			textOpen = true;
			enqueue({ id: TEXT_CHUNK_ID, type: "text-start" });
		}
		enqueue({ delta, id: TEXT_CHUNK_ID, type: "text-delta" });
	};
	const reasoningDelta = (delta: string): void => {
		if (!reasoningOpen) {
			reasoningOpen = true;
			enqueue({ id: REASONING_CHUNK_ID, type: "reasoning-start" });
		}
		enqueue({ delta, id: REASONING_CHUNK_ID, type: "reasoning-delta" });
	};
	const finishStep = (): void => {
		closeParts();
		enqueue({ type: "finish-step" });
	};

	return { closeParts, finishStep, openStep, reasoningDelta, textDelta };
};

/**
 * CLI-owned adapter: runs one text-only Agent Turn through the public Agent
 * Runtime and maps its Wincode Agent Turn Events onto the display chunk
 * stream the existing conversation executor consumes. The chunk protocol is
 * only the presentation boundary the application already owns; Agent Turn
 * Events remain the Wincode source of truth.
 */
export const createTextOnlyRuntimeStream = async ({
	runtime,
	signal,
	turn,
}: {
	runtime: AgentRuntime;
	signal?: AbortSignal;
	turn: AgentTurn;
}): Promise<ReadableStream<UIMessageChunk>> =>
	new ReadableStream<UIMessageChunk>({
		async start(controller) {
			const enqueue = (chunk: UIMessageChunk): void => {
				controller.enqueue(chunk);
			};
			const writer = createPartWriter(enqueue);
			let terminalEmitted = false;
			const emitTerminal = (chunk: UIMessageChunk): void => {
				writer.closeParts();
				terminalEmitted = true;
				enqueue(chunk);
			};
			try {
				for await (const event of runtime.run(turn, { signal })) {
					if (signal?.aborted) {
						break;
					}
					switch (event.type) {
						case "agent-turn-started": {
							break;
						}
						case "model-step-started": {
							writer.openStep();
							break;
						}
						case "reasoning-delta": {
							writer.reasoningDelta(event.delta);
							break;
						}
						case "text-delta": {
							writer.textDelta(event.delta);
							break;
						}
						case "model-step-finished": {
							writer.finishStep();
							break;
						}
						case "agent-turn-completed": {
							emitTerminal({
								finishReason: "stop",
								...(event.usage === undefined
									? {}
									: { messageMetadata: { usage: event.usage } }),
								type: "finish",
							});
							break;
						}
						case "agent-turn-failed": {
							emitTerminal({
								errorText: event.failure.message,
								type: "error",
							});
							break;
						}
						default: {
							break;
						}
					}
				}
			} catch {
				emitTerminal({
					errorText: "The Agent Turn failed unexpectedly.",
					type: "error",
				});
			}
			// A run stopped by caller abort (or truncated without an outcome)
			// emits no terminal event; close any open parts so the executor
			// never keeps streaming text parts past the stream end.
			if (!terminalEmitted) {
				writer.closeParts();
			}
			controller.close();
		},
	});
