import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as path from "node:path";
import type {
	AgentRuntime,
	AgentTurn,
	AgentTurnEvent,
	SessionRecord,
} from "@wincode/agent-core";
import { createOperationalFailure } from "@wincode/agent-core";
import { createModelTarget } from "@wincode/ai/model-target";
import { isObjectLike, isUndefined } from "@wincode/utils";
import { z } from "zod";
import { buildAgent } from "@/modules/agents/built-ins";
import { RetiredModelError } from "@/modules/model-target";
import {
	buildAgentTurn,
	isSettledSessionToolCallPart,
	resolveTurnTools,
	runAgentTurnToText,
} from "@/modules/sessions/hooks/runtime-turn";
import { buildAssistantFailureSessionRecord } from "@/modules/sessions/turn-records";
import {
	createMemoryFileObservationStore,
	getToolResourceLimits,
} from "@/modules/tools";
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

test("replays namespaced Plugin tool calls without core-specific tool names", () => {
	const pluginTool = {
		input: { title: "Investigate" },
		output: { issue: "W-42" },
		state: "output-available",
		toolCallId: toolCallId("plugin-call"),
		type: "tool-jira:create_issue",
	};

	expect(isSettledSessionToolCallPart(pluginTool)).toBe(true);
	expect(
		isSettledSessionToolCallPart({
			...pluginTool,
			type: "tool-",
		})
	).toBe(false);
});

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

test("places the Skill context before the user message it was selected for", () => {
	const turn = buildAgentTurn({
		agent: agentId("build"),
		modelMessages: [
			{
				id: sessionMessageId("skill-message"),
				parts: [{ text: "Review the auth flow", type: "text" }],
				role: "user",
			},
		],
		modelTarget: createTurn().model,
		resolvedAgent: buildAgent,
		skill: {
			contentHash: "hash-1",
			instructions: "Review carefully.",
			name: "review",
			source: "explicit",
		},
		turnId: agentTurnId("turn-skill-order"),
	});

	expect(turn.input.messages.map(({ role }) => role)).toEqual(["user", "user"]);
	expect(turn.input.messages[0]?.parts).toEqual([
		{
			text: '<untrusted-skill-context name="review" source="explicit" content-hash="hash-1">\nReview carefully.\n</untrusted-skill-context>',
			type: "text",
		},
	]);
	expect(turn.input.messages[1]?.parts).toEqual([
		{ text: "Review the auth flow", type: "text" },
	]);
});

test("appends the Skill context when the current user message is absent", () => {
	const turn = buildAgentTurn({
		agent: agentId("build"),
		modelMessages: [
			{
				id: sessionMessageId("older-user"),
				parts: [{ text: "earlier request", type: "text" }],
				role: "user",
			},
			{
				id: sessionMessageId("assistant-1"),
				parts: [{ text: "earlier answer", type: "text" }],
				role: "assistant",
			},
		],
		modelTarget: createTurn().model,
		resolvedAgent: buildAgent,
		skill: {
			contentHash: "hash-1",
			instructions: "Review carefully.",
			name: "review",
			source: "explicit",
		},
		turnId: agentTurnId("turn-skill-append"),
	});

	// A Skill-only submission records an empty user message that the model
	// input drops: the context must not attach to the older user message.
	expect(turn.input.messages.map(({ role }) => role)).toEqual([
		"user",
		"assistant",
		"user",
	]);
	expect(turn.input.messages[0]?.parts).toEqual([
		{ text: "earlier request", type: "text" },
	]);
	expect(turn.input.messages[2]?.parts).toEqual([
		{
			text: expect.stringContaining('name="review"'),
			type: "text",
		},
	]);
});

test("appends the Skill context when the current user message is empty", () => {
	const turn = buildAgentTurn({
		agent: agentId("build"),
		modelMessages: [
			{
				id: sessionMessageId("older-user"),
				parts: [{ text: "earlier request", type: "text" }],
				role: "user",
			},
			{
				id: sessionMessageId("empty-user"),
				parts: [{ text: "", type: "text" }],
				role: "user",
			},
		],
		modelTarget: createTurn().model,
		resolvedAgent: buildAgent,
		skill: {
			contentHash: "hash-1",
			instructions: "Review carefully.",
			name: "review",
			source: "explicit",
		},
		turnId: agentTurnId("turn-skill-empty"),
	});

	// The empty user message never reaches the model input, so the context must
	// not splice before the older user message.
	expect(turn.input.messages.map(({ role }) => role)).toEqual(["user", "user"]);
	expect(turn.input.messages[0]?.id).toBe(sessionMessageId("older-user"));
	expect(turn.input.messages[1]?.parts).toEqual([
		{
			text: expect.stringContaining('name="review"'),
			type: "text",
		},
	]);
});

test("Agent Turn shell schemas enforce the active resource profile command limit", async () => {
	const shellToolFor = async (profile: "standard" | "extended" | "deep") => {
		const tool = (
			await resolveTurnTools({
				agentTools: ["shell"],
				resourceLimits: getToolResourceLimits(profile),
			})
		)[0];
		if (isUndefined(tool)) {
			throw new Error("The shell tool was not registered.");
		}
		const schema = tool.definition.inputSchema;
		if (!("safeParse" in schema)) {
			throw new Error("The shell definition has no executable input schema.");
		}
		return schema;
	};

	for (const profile of ["standard", "extended", "deep"] as const) {
		const maxCommandChars =
			getToolResourceLimits(profile).shell.maxCommandChars;
		const schema = await shellToolFor(profile);

		expect(
			schema.safeParse({ command: `:${" ".repeat(maxCommandChars - 1)}` })
				.success
		).toBe(true);
		expect(
			schema.safeParse({ command: `:${" ".repeat(maxCommandChars)}` }).success
		).toBe(false);
		expect(z.toJSONSchema(schema)).toMatchObject({
			properties: {
				command: {
					maxLength: maxCommandChars,
				},
			},
		});
	}
});

test("selected coding tools execute directly and remain Agent-selective", async () => {
	const root = await mkdtemp(
		path.join(process.cwd(), ".wincode-selected-tools-")
	);
	const filePath = path.join(root, "selected.txt");
	try {
		const writeTool = (await resolveTurnTools({ agentTools: ["write"] })).find(
			({ definition }) => definition.name === "write"
		);
		if (isUndefined(writeTool)) {
			throw new Error("The selected write tool was not resolved.");
		}
		const result = await writeTool.execute({
			input: {
				content: "selected write\n",
				expectedVersion: null,
				path: filePath,
			},
			toolCallId: toolCallId("selected-write"),
		});
		expect(result.type).toBe("success");
		expect(await Bun.file(filePath).text()).toBe("selected write\n");

		const readOnlyTools = await resolveTurnTools({ agentTools: ["read"] });
		expect(
			readOnlyTools.some(({ definition }) => definition.name === "write")
		).toBe(false);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("forwards cancellation to a running coding tool", async () => {
	const [shellTool] = await resolveTurnTools({
		agentTools: ["shell"],
	});
	if (isUndefined(shellTool)) {
		throw new Error("The shell tool was not registered.");
	}
	const abortController = new AbortController();
	const abort = Bun.sleep(50).then(() => abortController.abort());
	const result = await shellTool.execute(
		{
			input: { command: "sleep 2" },
			toolCallId: toolCallId("shell-abort-test"),
		},
		{ signal: abortController.signal }
	);
	await abort;
	expect(result.type).toBe("success");
	if (result.type !== "success") {
		throw new Error(result.errorText);
	}
	if (!isObjectLike(result.output)) {
		throw new Error("The shell tool returned an invalid output.");
	}
	expect(Reflect.get(result.output, "exitCode")).toBeNull();
});

test("Agent Turn definitions restrict edit input to the active mode", async () => {
	const editTool = (
		await resolveTurnTools({
			agentTools: ["edit"],
			versionedEditing: {
				editMode: "replace",
				sessionId: sessionId("catalog-edit-mode"),
				store: createMemoryFileObservationStore(),
			},
		})
	).find(({ definition }) => definition.name === "edit");
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
			takenAtBoundary = (await options?.takeSteeringMessages?.()) ?? [];
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
