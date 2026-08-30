/**
 * Regression tests for the agentic auto-continue behavior:
 *
 * The AI SDK (ai@6) auto-continues a turn whenever the last assistant step's
 * tool calls all have outputs and no request is in flight — including after
 * `stop()` and during the tool-execution gap between steps. That made a turn
 * look like it stopped and restarted on its own, and made Esc interrupt
 * unreliable (interrupt during the gap was a silent no-op; late tool outputs
 * after an abort restarted the turn).
 *
 * The S2/S3 tests drive the REAL `AbstractChat` from the installed `ai`
 * package with the app's `createAutoSendGate`, so they lock the bug pattern
 * at the exact seam `useChat` configures (see auto-send-gate.ts).
 */

import { describe, expect, test } from "bun:test";
import type { CodingAgentUIMessage } from "@wincode/ai";
import type { UIMessageChunk } from "ai";
import {
	AbstractChat,
	type ChatState,
	type ChatStatus,
	lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import {
	createAutoSendGate,
	hasPendingToolExecutionStep,
} from "./auto-send-gate";

const TOOL_CALL_ID = "call-1";
const POLL_INTERVAL_MS = 10;
const SETTLE_MS = 150;
const TOOL_EXECUTION_DELAY_MS = 20;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const makeState = (
	initialMessages: CodingAgentUIMessage[] = []
): ChatState<CodingAgentUIMessage> => {
	let messages: CodingAgentUIMessage[] = initialMessages;
	let status: ChatStatus = "ready";
	return {
		get messages() {
			return messages;
		},
		set messages(next: CodingAgentUIMessage[]) {
			messages = [...next];
		},
		get status() {
			return status;
		},
		set status(next: ChatStatus) {
			status = next;
		},
		error: undefined,
		pushMessage: (message: CodingAgentUIMessage) => {
			messages = messages.concat(message);
		},
		popMessage: () => {
			messages = messages.slice(0, -1);
		},
		replaceMessage: (index: number, message: CodingAgentUIMessage) => {
			messages = [
				...messages.slice(0, index),
				structuredClone(message),
				...messages.slice(index + 1),
			];
		},
		snapshot: <T>(thing: T): T => structuredClone(thing),
	};
};

class TestChat extends AbstractChat<CodingAgentUIMessage> {
	getState() {
		return this.state;
	}
}

const toolStepChunks = (toolCallId: string): UIMessageChunk[] => [
	{ type: "start" },
	{ type: "start-step" },
	{ toolCallId, toolName: "shell", type: "tool-input-start" },
	{
		input: { command: "ls" },
		toolCallId,
		toolName: "shell",
		type: "tool-input-available",
	},
	{ type: "finish-step" },
	{ type: "finish" },
];

const createChat = ({
	gate,
	chunks,
	holdOpen = false,
	onToolCall,
}: {
	gate: ReturnType<typeof createAutoSendGate>;
	chunks: UIMessageChunk[];
	holdOpen?: boolean;
	onToolCall?: () => void;
}) => {
	let sendCount = 0;
	const transport = {
		sendMessages: async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
			sendCount += 1;
			return new ReadableStream({
				start(controller) {
					for (const chunk of chunks) {
						controller.enqueue(chunk);
					}
					if (!holdOpen) {
						controller.close();
						return;
					}
					// Keep the stream open so the request stays genuinely live
					// (status "streaming") until stop() aborts it.
					abortSignal?.addEventListener("abort", () =>
						controller.error(new DOMException("aborted", "AbortError"))
					);
				},
			});
		},
		reconnectToStream: async () => null,
	};
	const chat = new TestChat({
		id: "session-1",
		onToolCall: onToolCall ?? (() => undefined),
		sendAutomaticallyWhen: gate.shouldAutoSend,
		state: makeState(),
		transport,
	});
	return { chat, getSendCount: () => sendCount };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitFor timed out");
		}
		await sleep(POLL_INTERVAL_MS);
	}
};

type DynamicToolPart = Extract<
	CodingAgentUIMessage["parts"][number],
	{ type: "dynamic-tool" }
>;

const assistantMetadata: CodingAgentUIMessage["metadata"] = {
	agent: "build",
	model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
};

const assistantMessageWithTool = (
	part: DynamicToolPart
): CodingAgentUIMessage => ({
	id: "assistant-1",
	metadata: assistantMetadata,
	parts: [{ type: "step-start" }, part],
	role: "assistant",
});

const textOnlyAssistantMessage: CodingAgentUIMessage = {
	id: "assistant-1",
	metadata: assistantMetadata,
	parts: [{ type: "step-start" }, { text: "done", type: "text" }],
	role: "assistant",
};

const userMessage: CodingAgentUIMessage = {
	id: "user-1",
	metadata: {},
	parts: [{ text: "hi", type: "text" }],
	role: "user",
};

describe("hasPendingToolExecutionStep", () => {
	test("true while the last step's tool call still awaits output", () => {
		const messages: CodingAgentUIMessage[] = [
			userMessage,
			assistantMessageWithTool({
				input: { command: "ls" },
				state: "input-available",
				toolCallId: TOOL_CALL_ID,
				toolName: "mcp_echo",
				type: "dynamic-tool",
			}),
		];
		expect(hasPendingToolExecutionStep(messages)).toBe(true);
	});

	test("false once the tool output landed", () => {
		const messages: CodingAgentUIMessage[] = [
			userMessage,
			assistantMessageWithTool({
				input: { command: "ls" },
				output: { ok: true },
				state: "output-available",
				toolCallId: TOOL_CALL_ID,
				toolName: "mcp_echo",
				type: "dynamic-tool",
			}),
		];
		expect(hasPendingToolExecutionStep(messages)).toBe(false);
	});

	test("false when the tool errored", () => {
		const messages: CodingAgentUIMessage[] = [
			userMessage,
			assistantMessageWithTool({
				errorText: "boom",
				input: { command: "ls" },
				state: "output-error",
				toolCallId: TOOL_CALL_ID,
				toolName: "mcp_echo",
				type: "dynamic-tool",
			}),
		];
		expect(hasPendingToolExecutionStep(messages)).toBe(false);
	});

	test("false when the tool was denied", () => {
		const messages: CodingAgentUIMessage[] = [
			userMessage,
			assistantMessageWithTool({
				input: { command: "ls" },
				approval: { approved: false, id: "approval-1" },
				state: "output-denied",
				toolCallId: TOOL_CALL_ID,
				toolName: "mcp_echo",
				type: "dynamic-tool",
			}),
		];
		expect(hasPendingToolExecutionStep(messages)).toBe(false);
	});

	test("false for a text-only last step", () => {
		const messages: CodingAgentUIMessage[] = [
			userMessage,
			textOnlyAssistantMessage,
		];
		expect(hasPendingToolExecutionStep(messages)).toBe(false);
	});

	test("false when the last message is a user message", () => {
		const messages: CodingAgentUIMessage[] = [userMessage];
		expect(hasPendingToolExecutionStep(messages)).toBe(false);
	});

	test("false for a pending part restored from storage (no in-flight execution)", () => {
		const messages: CodingAgentUIMessage[] = [
			userMessage,
			assistantMessageWithTool({
				input: { command: "ls" },
				state: "input-available",
				toolCallId: TOOL_CALL_ID,
				toolName: "mcp_echo",
				type: "dynamic-tool",
			}),
		];
		expect(
			hasPendingToolExecutionStep(messages, new Set(["assistant-1"]))
		).toBe(false);
		// The same message in a live session (id not restored from storage)
		// still counts as in-flight.
		expect(hasPendingToolExecutionStep(messages)).toBe(true);
	});

	test("false for a never-dispatched input-streaming part (aborted mid-input)", () => {
		const messages: CodingAgentUIMessage[] = [
			userMessage,
			assistantMessageWithTool({
				input: { command: "ls" },
				state: "input-streaming",
				toolCallId: TOOL_CALL_ID,
				toolName: "mcp_echo",
				type: "dynamic-tool",
			}),
		];
		// The SDK dispatches executions only once the input is available; an
		// aborted mid-input part never had an execution started, so no output
		// will ever arrive and it must not hold isBusy true.
		expect(hasPendingToolExecutionStep(messages)).toBe(false);
	});

	test("only the last step counts (earlier tool calls in the same message are done)", () => {
		const finishedTool: DynamicToolPart = {
			input: { command: "ls" },
			output: { ok: true },
			state: "output-available",
			toolCallId: TOOL_CALL_ID,
			toolName: "mcp_echo",
			type: "dynamic-tool",
		};
		const assistant: CodingAgentUIMessage = {
			id: "assistant-1",
			metadata: assistantMetadata,
			parts: [
				{ type: "step-start" },
				finishedTool,
				{ type: "step-start" },
				{ text: "done", type: "text" },
			],
			role: "assistant",
		};
		const messages: CodingAgentUIMessage[] = [userMessage, assistant];
		expect(hasPendingToolExecutionStep(messages)).toBe(false);
	});
});

describe("createAutoSendGate", () => {
	const completeStepMessages: CodingAgentUIMessage[] = [
		userMessage,
		assistantMessageWithTool({
			input: { command: "ls" },
			output: { ok: true },
			state: "output-available",
			toolCallId: TOOL_CALL_ID,
			toolName: "mcp_echo",
			type: "dynamic-tool",
		}),
	];

	test("auto-send gates on the SDK completion predicate when not interrupted", () => {
		const gate = createAutoSendGate();
		const messages = completeStepMessages;
		expect(gate.shouldAutoSend({ messages })).toBe(
			lastAssistantMessageIsCompleteWithToolCalls({ messages })
		);
	});

	test("an interrupted turn never auto-sends, even when the step is complete", () => {
		const gate = createAutoSendGate();
		const messages = completeStepMessages;
		gate.disable();
		expect(gate.shouldAutoSend({ messages })).toBe(false);
	});

	test("a fresh turn after the interrupt auto-sends again", () => {
		const gate = createAutoSendGate();
		const messages = completeStepMessages;
		gate.disable();
		gate.enable();
		expect(gate.shouldAutoSend({ messages })).toBe(true);
	});

	test("pauses continuation during asynchronous compaction", () => {
		const gate = createAutoSendGate();
		const messages = completeStepMessages;
		gate.pause();
		expect(gate.shouldAutoSend({ messages })).toBe(false);
		gate.resume();
		expect(gate.shouldAutoSend({ messages })).toBe(true);
	});
});

const postInterruptToolOutputAndAssertStopped = async (
	chat: TestChat,
	getSendCount: () => number
) => {
	// The in-flight tool execution finishes AFTER the interrupt.
	await chat.addToolOutput({
		output: { exitCode: 0, output: "done" },
		state: "output-available",
		tool: "shell",
		toolCallId: TOOL_CALL_ID,
	});
	// Wait a beat for any auto-send.
	await sleep(SETTLE_MS);
	expect(getSendCount()).toBe(1);
};

describe("auto-continue against the real AbstractChat (ai@6)", () => {
	test("interrupt during the tool-execution gap: turn must NOT resume when the late output lands", async () => {
		const gate = createAutoSendGate();
		const { chat, getSendCount } = createChat({
			chunks: toolStepChunks(TOOL_CALL_ID),
			gate,
		});
		await chat.sendMessage({
			messageId: undefined,
			metadata: undefined,
			parts: [{ text: "hi", type: "text" }],
		});
		// The stream ended but the tool is still executing: status "ready",
		// which is exactly the window where `chat.stop()` is a no-op.
		const state = chat.getState();
		await waitFor(() => state.status === "ready");

		// User presses Esc Esc -> interruptLatestAssistantMessage.
		gate.disable();
		await chat.stop();

		await postInterruptToolOutputAndAssertStopped(chat, getSendCount);
	});

	test("interrupt mid-stream: a late tool output must NOT restart the turn", async () => {
		const gate = createAutoSendGate();
		const { chat, getSendCount } = createChat({
			chunks: toolStepChunks(TOOL_CALL_ID),
			gate,
			holdOpen: true,
		});
		// Fire without awaiting: the transport stream stays open, so the
		// request is genuinely live (status "streaming") when the interrupt
		// lands, and stop() drives the real abort path (isAbort).
		const sendPromise = chat.sendMessage({
			messageId: undefined,
			metadata: undefined,
			parts: [{ text: "hi", type: "text" }],
		});
		const state = chat.getState();
		await waitFor(() => state.status === "streaming");

		// User interrupts while the request is live.
		gate.disable();
		await chat.stop();
		await sendPromise;

		await waitFor(() => state.status === "ready");

		await postInterruptToolOutputAndAssertStopped(chat, getSendCount);
	});

	test("an uninterrupted turn still auto-continues across steps", async () => {
		const gate = createAutoSendGate();
		const { chat, getSendCount } = createChat({
			chunks: toolStepChunks(TOOL_CALL_ID),
			onToolCall: () => {
				// Fire-and-forget execution like the app's onToolCall handler,
				// with the same rejection guard the production code applies.
				setTimeout(() => {
					Promise.resolve(
						chat.addToolOutput({
							output: { exitCode: 0, output: "done" },
							state: "output-available",
							tool: "shell",
							toolCallId: TOOL_CALL_ID,
						})
					).catch(() => undefined);
				}, TOOL_EXECUTION_DELAY_MS);
			},
			gate,
		});
		await chat.sendMessage({
			messageId: undefined,
			metadata: undefined,
			parts: [{ text: "hi", type: "text" }],
		});
		await waitFor(() => getSendCount() >= 2);

		expect(getSendCount()).toBe(2);
	});
});
