import { expect, test } from "bun:test";
import type {
	AgentRuntime,
	AgentTurn,
	AgentTurnEvent,
	ConversationRecord,
} from "@wincode/agent-core";
import { createOperationalFailure } from "@wincode/agent-core";
import { createModelTarget } from "@wincode/ai/model-target";
import { buildAgent } from "../../agents/built-ins";
import {
	buildAgentTurn,
	createGatedCodingTools,
	runAgentTurnToText,
} from "./runtime-turn";

const model = { modelId: "gpt-5.4-mini", providerId: "openai" } as const;

const createTurn = (): AgentTurn => ({
	agent: {
		displayName: "Build",
		id: "build",
		instructions: "Implement the request.",
		role: "primary",
	},
	id: "turn-runtime-test",
	input: {
		messages: [
			{
				id: "message-user",
				parts: [{ text: "Read the attached note", type: "text" }],
				role: "user",
			},
		],
	},
	model: createModelTarget(model, {
		apiKey: "test-key",
		kind: "api-key",
	}),
});

test("keeps inline file parts in the Agent Turn model input", () => {
	const imageData = "data:image/png;base64,AA==";
	const turn = buildAgentTurn({
		agent: "build",
		modelMessages: [
			{
				id: "image-message",
				parts: [
					{ text: "Inspect this image", type: "text" },
					{ mediaType: "image/png", type: "file", url: imageData },
				],
				role: "user",
			},
		],
		modelTarget: createTurn().model,
		resolvedAgent: buildAgent,
		turnId: "turn-file-input",
	});

	expect(turn.input.messages).toEqual([
		{
			id: "image-message",
			parts: [
				{ text: "Inspect this image", type: "text" },
				{
					data: imageData,
					mediaType: "image/png",
					type: "file",
				},
			],
			role: "user",
		},
	]);
});

class AbortOnSecondReadSignal extends EventTarget implements AbortSignal {
	private readCount = 0;
	readonly onabort: AbortSignal["onabort"] = null;
	readonly reason: AbortSignal["reason"] = new Error("Test signal aborted.");

	get aborted(): boolean {
		this.readCount += 1;
		return this.readCount >= 2;
	}
	throwIfAborted(): void {
		if (this.aborted) {
			throw this.reason;
		}
	}
}

test("forwards cancellation to a running coding tool", async () => {
	const [shellTool] = createGatedCodingTools({
		agentTools: ["shell"],
		gate: { gate: async () => ({ kind: "allow" }) },
	});
	if (shellTool === undefined) {
		throw new Error("The shell tool was not registered.");
	}
	const result = await shellTool.execute(
		{ input: { command: "sleep 2" }, toolCallId: "shell-abort-test" },
		{ signal: new AbortOnSecondReadSignal() }
	);
	expect(result.type).toBe("success");
	if (result.type !== "success") {
		throw new Error(result.errorText);
	}
	if (typeof result.output !== "object" || result.output === null) {
		throw new Error("The shell tool returned an invalid output.");
	}
	expect(Reflect.get(result.output, "exitCode")).toBeNull();
});

test("commits only the durable assistant outcome before exposing terminal output", async () => {
	const turn = createTurn();
	const callbackOrder: string[] = [];
	const checkpoints: ConversationRecord[] = [];
	const runtime: AgentRuntime = {
		async *run(currentTurn): AsyncGenerator<AgentTurnEvent> {
			yield {
				agentId: currentTurn.agent.id,
				sequence: 0,
				startedAt: 100,
				turnId: currentTurn.id,
				type: "agent-turn-started",
			};
			yield {
				delta: "internal",
				sequence: 1,
				turnId: currentTurn.id,
				type: "reasoning-delta",
			};
			yield {
				delta: "Done",
				sequence: 2,
				turnId: currentTurn.id,
				type: "text-delta",
			};
			yield {
				finishedAt: 200,
				sequence: 3,
				turnId: currentTurn.id,
				type: "agent-turn-completed",
				usage: { inputTokens: 12, outputTokens: 4 },
			};
		},
	};

	const result = await runAgentTurnToText({
		onCheckpoint: (record) => {
			callbackOrder.push("checkpoint");
			checkpoints.push(record);
		},
		onTerminal: (event) => {
			callbackOrder.push(`terminal:${event.type}`);
		},
		runtime,
		turn,
	});

	expect(result).toBe("Done");
	expect(callbackOrder).toEqual([
		"checkpoint",
		"terminal:agent-turn-completed",
	]);
	expect(checkpoints).toHaveLength(1);
	const record = checkpoints[0];
	if (record === undefined) {
		throw new Error("The runtime did not produce a Conversation Record.");
	}
	expect(record.outcome).toMatchObject({
		kind: "assistant",
		terminal: { finishedAt: 200, kind: "completed" },
	});
	expect(record.messages).toEqual([
		{
			id: "assistant-turn-runtime-test",
			metadata: {
				model,
				usage: { inputTokens: 12, outputTokens: 4 },
			},
			parts: [{ text: "Done", type: "text" }],
			role: "assistant",
		},
	]);
});

test("checkpoints completed Tool Calls separately from terminal assistant text", async () => {
	const turn = createTurn();
	const checkpoints: ConversationRecord[] = [];
	const runtime: AgentRuntime = {
		async *run(currentTurn): AsyncGenerator<AgentTurnEvent> {
			yield {
				agentId: currentTurn.agent.id,
				sequence: 0,
				startedAt: 100,
				turnId: currentTurn.id,
				type: "agent-turn-started",
			};
			yield {
				input: { command: "git status" },
				sequence: 1,
				toolCallId: "call-1",
				toolName: "shell",
				turnId: currentTurn.id,
				type: "tool-call-started",
			};
			yield {
				outcome: { output: { exitCode: 0 }, type: "success" },
				sequence: 2,
				toolCallId: "call-1",
				toolName: "shell",
				turnId: currentTurn.id,
				type: "tool-call-finished",
			};
			yield {
				delta: "Done",
				sequence: 3,
				turnId: currentTurn.id,
				type: "text-delta",
			};
			yield {
				finishedAt: 200,
				sequence: 4,
				turnId: currentTurn.id,
				type: "agent-turn-completed",
			};
		},
	};

	await runAgentTurnToText({
		onCheckpoint: (record) => {
			checkpoints.push(record);
		},
		onToolCheckpoint: (record) => {
			checkpoints.push(record);
		},
		runtime,
		turn,
	});

	expect(checkpoints.map(({ outcome }) => outcome.kind)).toEqual([
		"tool",
		"assistant",
	]);
	expect(checkpoints[0]?.messages[0]?.parts).toEqual([
		{
			input: { command: "git status" },
			outcome: { kind: "success", output: { exitCode: 0 } },
			sequence: 2,
			toolCallId: "call-1",
			toolName: "shell",
			type: "tool-call",
		},
	]);
	expect(checkpoints[1]?.messages[0]?.parts).toEqual([
		{ text: "Done", type: "text" },
	]);
});

test("does not synthesize an assistant record for a tool-only turn", async () => {
	const turn = createTurn();
	const checkpoints: ConversationRecord[] = [];
	const runtime: AgentRuntime = {
		async *run(currentTurn): AsyncGenerator<AgentTurnEvent> {
			yield {
				agentId: currentTurn.agent.id,
				sequence: 0,
				startedAt: 100,
				turnId: currentTurn.id,
				type: "agent-turn-started",
			};
			yield {
				input: { command: "git status" },
				sequence: 1,
				toolCallId: "call-tool-only",
				toolName: "shell",
				turnId: currentTurn.id,
				type: "tool-call-started",
			};
			yield {
				outcome: { output: { exitCode: 0 }, type: "success" },
				sequence: 2,
				toolCallId: "call-tool-only",
				toolName: "shell",
				turnId: currentTurn.id,
				type: "tool-call-finished",
			};
			yield {
				finishedAt: 200,
				sequence: 3,
				turnId: currentTurn.id,
				type: "agent-turn-completed",
			};
		},
	};

	expect(
		await runAgentTurnToText({
			onCheckpoint: (record) => {
				checkpoints.push(record);
			},
			onToolCheckpoint: (record) => {
				checkpoints.push(record);
			},
			runtime,
			turn,
		})
	).toBe("");
	expect(checkpoints.map(({ outcome }) => outcome.kind)).toEqual(["tool"]);
});

test("persists an empty assistant outcome when no Tool Call ran", async () => {
	const turn = createTurn();
	const checkpoints: ConversationRecord[] = [];
	const runtime: AgentRuntime = {
		async *run(currentTurn): AsyncGenerator<AgentTurnEvent> {
			yield {
				agentId: currentTurn.agent.id,
				sequence: 0,
				startedAt: 100,
				turnId: currentTurn.id,
				type: "agent-turn-started",
			};
			yield {
				finishedAt: 200,
				sequence: 1,
				turnId: currentTurn.id,
				type: "agent-turn-completed",
			};
		},
	};

	await runAgentTurnToText({
		onCheckpoint: (record) => {
			checkpoints.push(record);
		},
		runtime,
		turn,
	});

	expect(checkpoints.map(({ outcome }) => outcome.kind)).toEqual(["assistant"]);
	expect(checkpoints[0]?.messages[0]?.parts).toEqual([
		{ text: "", type: "text" },
	]);
});

test("persists safe failure text instead of streamed partial assistant output", async () => {
	const turn = createTurn();
	const checkpoints: ConversationRecord[] = [];
	const runtime: AgentRuntime = {
		async *run(currentTurn): AsyncGenerator<AgentTurnEvent> {
			yield {
				agentId: currentTurn.agent.id,
				sequence: 0,
				startedAt: 100,
				turnId: currentTurn.id,
				type: "agent-turn-started",
			};
			yield {
				delta: "partial output",
				sequence: 1,
				turnId: currentTurn.id,
				type: "text-delta",
			};
			yield {
				failure: createOperationalFailure({
					code: "unknown",
					retry: "never",
					source: "model",
				}),
				finishedAt: 200,
				sequence: 2,
				turnId: currentTurn.id,
				type: "agent-turn-failed",
			};
		},
	};

	await expect(
		runAgentTurnToText({
			onCheckpoint: (record) => {
				checkpoints.push(record);
			},
			runtime,
			turn,
		})
	).rejects.toThrow("The model request failed.");

	expect(checkpoints).toHaveLength(1);
	expect(checkpoints[0]?.messages[0]?.parts).toEqual([
		{ text: "The model request failed.", type: "text" },
	]);
	expect(checkpoints[0]?.outcome).toMatchObject({
		kind: "assistant",
		terminal: { kind: "failed" },
	});
});

test("surfaces terminal checkpoint failures without exposing terminal output", async () => {
	const turn = createTurn();
	let terminalObserved = false;
	const runtime: AgentRuntime = {
		async *run(currentTurn): AsyncGenerator<AgentTurnEvent> {
			yield {
				agentId: currentTurn.agent.id,
				sequence: 0,
				startedAt: 100,
				turnId: currentTurn.id,
				type: "agent-turn-started",
			};
			yield {
				delta: "Done",
				sequence: 1,
				turnId: currentTurn.id,
				type: "text-delta",
			};
			yield {
				finishedAt: 200,
				sequence: 2,
				turnId: currentTurn.id,
				type: "agent-turn-completed",
			};
		},
	};

	await expect(
		runAgentTurnToText({
			onCheckpoint: () => {
				throw new Error("disk unavailable");
			},
			onTerminal: () => {
				terminalObserved = true;
			},
			runtime,
			turn,
		})
	).rejects.toThrow("The Agent Turn outcome could not be persisted.");
	expect(terminalObserved).toBe(false);
});
