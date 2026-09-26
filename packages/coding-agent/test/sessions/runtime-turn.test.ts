import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
// biome-ignore lint/performance/noNamespaceImport: AGENTS.md requires namespace imports for node modules.
import * as path from "node:path";
import type {
	AgentRuntime,
	AgentTurn,
	AgentTurnEvent,
	SessionRecord,
} from "@wincode/agent-core";
import { createOperationalFailure } from "@wincode/agent-core";
import { createModelTarget } from "@wincode/ai/model-target";
import { isObjectLike, isUndefined } from "@wincode/runtime-utils";
import { buildAgent } from "@/modules/agents/built-ins";
import { RetiredModelError } from "@/modules/model-target";
import {
	buildAgentTurn,
	createGatedCodingTools,
	runAgentTurnToText,
} from "@/modules/sessions/hooks/runtime-turn";
import { buildAssistantFailureSessionRecord } from "@/modules/sessions/turn-records";
import { createMemoryFileObservationStore } from "@/modules/tools";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionId,
	sessionMessageId,
	toolCallId,
} from "../support/identifiers";

const model = {
	modelId: modelId("gpt-5.6-luna"),
	providerId: "openai",
} as const;

test("preserves the actionable retired-model refusal in the failure message", () => {
	// Regression #57: retired sessions must tell the user how to recover.
	const record = buildAssistantFailureSessionRecord({
		agentId: agentId("build"),
		error: new RetiredModelError("openai", "gpt-5.6-luna"),
		model,
		turnId: agentTurnId("turn-retired-model"),
	});

	expect(record.messages[0]?.parts).toEqual([
		{
			text: "Model openai/gpt-5.6-luna is no longer available. Choose another model to continue this session.",
			type: "text",
		},
	]);
});

const createTurn = (): AgentTurn => ({
	agent: {
		displayName: "Build",
		id: agentId("build"),
		instructions: "Implement the request.",
		role: "primary",
	},
	id: agentTurnId("turn-runtime-test"),
	input: {
		messages: [
			{
				id: sessionMessageId("message-user"),
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
		agent: agentId("build"),
		modelMessages: [
			{
				id: sessionMessageId("image-message"),
				parts: [
					{ text: "Inspect this image", type: "text" },
					{ mediaType: "image/png", type: "file", url: imageData },
				],
				role: "user",
			},
		],
		modelTarget: createTurn().model,
		resolvedAgent: buildAgent,
		turnId: agentTurnId("turn-file-input"),
	});

	expect(turn.input.messages).toEqual([
		{
			id: sessionMessageId("image-message"),
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
	if (isUndefined(shellTool)) {
		throw new Error("The shell tool was not registered.");
	}
	const result = await shellTool.execute(
		{
			input: { command: "sleep 2" },
			toolCallId: toolCallId("shell-abort-test"),
		},
		{ signal: new AbortOnSecondReadSignal() }
	);
	expect(result.type).toBe("success");
	if (result.type !== "success") {
		throw new Error(result.errorText);
	}
	if (!isObjectLike(result.output)) {
		throw new Error("The shell tool returned an invalid output.");
	}
	expect(Reflect.get(result.output, "exitCode")).toBeNull();
});

test("coding tools execute only after the gate and remain Agent-selective", async () => {
	const root = await mkdtemp(path.join(process.cwd(), ".wincode-catalog-"));
	const allowedPath = path.join(root, "allowed.txt");
	const deniedPath = path.join(root, "denied.txt");
	try {
		let allowedGateCalls = 0;
		const allowedTool = createGatedCodingTools({
			agentTools: ["write"],
			gate: {
				gate: async () => {
					allowedGateCalls += 1;
					return { kind: "allow" };
				},
			},
		}).find(({ definition }) => definition.name === "write");
		if (isUndefined(allowedTool)) {
			throw new Error("The selected write tool was not resolved.");
		}
		const allowed = await allowedTool.execute({
			input: { content: "gated write\n", path: allowedPath },
			toolCallId: toolCallId("catalog-write-allowed"),
		});
		expect(allowed.type).toBe("success");
		expect(allowedGateCalls).toBe(1);
		expect(await globalThis.Bun.file(allowedPath).text()).toBe("gated write\n");

		let deniedGateCalls = 0;
		const deniedTool = createGatedCodingTools({
			agentTools: ["write"],
			gate: {
				gate: async () => {
					deniedGateCalls += 1;
					return { errorText: "Write denied by policy.", kind: "deny" };
				},
			},
		}).find(({ definition }) => definition.name === "write");
		if (isUndefined(deniedTool)) {
			throw new Error("The selected write tool was not resolved.");
		}
		const denied = await deniedTool.execute({
			input: { content: "must not be written\n", path: deniedPath },
			toolCallId: toolCallId("catalog-write-denied"),
		});
		expect(denied).toMatchObject({
			errorText: "Write denied by policy.",
			type: "failure",
		});
		expect(deniedGateCalls).toBe(1);
		expect(await globalThis.Bun.file(deniedPath).exists()).toBe(false);

		const readOnlyTools = createGatedCodingTools({
			agentTools: ["read"],
			gate: { gate: async () => ({ kind: "allow" }) },
		});
		expect(
			readOnlyTools.some(({ definition }) => definition.name === "write")
		).toBe(false);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("Agent Turn definitions restrict edit input to the active mode", () => {
	const editTool = createGatedCodingTools({
		agentTools: ["edit"],
		gate: { gate: async () => ({ kind: "allow" }) },
		versionedEditing: {
			editMode: "replace",
			sessionId: sessionId("catalog-edit-mode"),
			store: createMemoryFileObservationStore(),
		},
	}).find(({ definition }) => definition.name === "edit");
	if (isUndefined(editTool)) {
		throw new Error("The selected edit tool was not resolved.");
	}
	expect(editTool.definition.description).toContain(
		"Active Edit Mode: replace."
	);
	const schema = editTool.definition.inputSchema;
	if (!("safeParse" in schema)) {
		throw new Error("The edit definition has no executable input schema.");
	}
	expect(
		schema.safeParse({
			mode: "replace",
			newString: "replacement",
			oldString: "original",
			path: "note.txt",
		}).success
	).toBe(true);
	expect(
		schema.safeParse({
			mode: "patch",
			patch: "*** Begin Patch",
		}).success
	).toBe(false);
});

test("commits only the durable assistant outcome before exposing terminal output", async () => {
	const turn = createTurn();
	const callbackOrder: string[] = [];
	const checkpoints: SessionRecord[] = [];
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
		sourceUserMessageId: sessionMessageId("message-user"),
		turn,
	});

	expect(result).toBe("Done");
	expect(callbackOrder).toEqual([
		"checkpoint",
		"terminal:agent-turn-completed",
	]);
	expect(checkpoints).toHaveLength(1);
	const record = checkpoints[0];
	if (isUndefined(record)) {
		throw new Error("The runtime did not produce a Session Record.");
	}
	expect(record.outcome).toMatchObject({
		kind: "assistant",
		terminal: { finishedAt: 200, kind: "completed" },
	});
	expect(record.messages).toEqual([
		{
			id: sessionMessageId("assistant-turn-runtime-test"),
			metadata: {
				model,
				sourceUserMessageId: sessionMessageId("message-user"),
				usage: { inputTokens: 12, outputTokens: 4 },
			},
			parts: [{ text: "Done", type: "text" }],
			role: "assistant",
		},
	]);
});

test("checkpoints completed Tool Calls separately from terminal assistant text", async () => {
	const turn = createTurn();
	const checkpoints: SessionRecord[] = [];
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
				toolCallId: toolCallId("call-1"),
				toolName: "shell",
				turnId: currentTurn.id,
				type: "tool-call-started",
			};
			yield {
				outcome: { output: { exitCode: 0 }, type: "success" },
				sequence: 2,
				toolCallId: toolCallId("call-1"),
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
			toolCallId: toolCallId("call-1"),
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
	const checkpoints: SessionRecord[] = [];
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
				toolCallId: toolCallId("call-tool-only"),
				toolName: "shell",
				turnId: currentTurn.id,
				type: "tool-call-started",
			};
			yield {
				outcome: { output: { exitCode: 0 }, type: "success" },
				sequence: 2,
				toolCallId: toolCallId("call-tool-only"),
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
	const checkpoints: SessionRecord[] = [];
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
	const checkpoints: SessionRecord[] = [];
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

test("hands Steering Messages to the runtime as Agent Turn messages", async () => {
	const turn = createTurn();
	let takenAtBoundary: AgentTurn["input"]["messages"] = [];
	const runtime: AgentRuntime = {
		async *run(currentTurn, options): AsyncGenerator<AgentTurnEvent> {
			yield {
				agentId: currentTurn.agent.id,
				sequence: 0,
				startedAt: 100,
				turnId: currentTurn.id,
				type: "agent-turn-started",
			};
			// The boundary the Agent Runtime reaches between Model Steps.
			takenAtBoundary = options?.takeSteeringMessages?.() ?? [];
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

	await runAgentTurnToText({
		runtime,
		takeSteeringMessages: () => [
			{
				id: sessionMessageId("message-steer"),
				metadata: { joinedTurnId: turn.id },
				parts: [{ text: "use the cache instead", type: "text" }],
				role: "user",
			},
		],
		turn,
	});

	// The Agent Session's Session Message crosses the boundary as an Agent Turn
	// message, so no session-layer type reaches the runtime.
	expect(takenAtBoundary).toEqual([
		{
			id: sessionMessageId("message-steer"),
			parts: [{ text: "use the cache instead", type: "text" }],
			role: "user",
		},
	]);
});
