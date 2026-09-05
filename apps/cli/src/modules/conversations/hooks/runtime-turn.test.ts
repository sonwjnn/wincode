import { expect, test } from "bun:test";
import type {
	AgentRuntime,
	AgentTurn,
	AgentTurnEvent,
	ConversationRecord,
} from "@wincode/agent-core";
import { createModelTarget } from "@wincode/ai/model-target";
import { buildAgent } from "../../agents/built-ins";
import type { ConversationMessage } from "../message";
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

const sourceMessages: ConversationMessage[] = [
	{
		id: "message-user",
		metadata: { model },
		parts: [
			{ text: "Read the attached note", type: "text" },
			{
				data: {
					byteLength: 12,
					content: "note contents",
					kind: "file",
					path: "notes/today.md",
					truncated: false,
				},
				type: "data-fileMention",
			},
			{
				attachmentId: `v1-${"a".repeat(64)}`,
				byteLength: 12,
				filename: "today.md",
				mediaType: "text/markdown",
				type: "file",
				url: `attachment://v1-${"a".repeat(64)}`,
			},
		],
		role: "user",
	},
];

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

test("commits the resolved source transcript before exposing terminal output", async () => {
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
		sourceMessages,
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
	expect(record.outcome).toMatchObject({ finishedAt: 200, kind: "completed" });
	expect(record.messages).toHaveLength(2);
	expect(record.messages[0]).toMatchObject({
		id: "message-user",
		role: "user",
	});
	expect(record.messages[0]?.parts[1]).toMatchObject({
		data: { path: "notes/today.md" },
		type: "file-mention",
	});
	expect(record.messages[0]?.parts[2]).toMatchObject({
		attachmentId: `v1-${"a".repeat(64)}`,
		filename: "today.md",
		type: "attachment-reference",
	});
	expect(record.messages[1]).toMatchObject({
		parts: [{ text: "Done", type: "text" }],
		role: "assistant",
	});
});
