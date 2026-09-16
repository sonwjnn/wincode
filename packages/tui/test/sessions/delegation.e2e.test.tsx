import { isUndefined } from "@wincode/runtime-utils";

const previousEnvironment = {
	WINCODE_E2E_HOME: process.env.WINCODE_E2E_HOME,
	WINCODE_E2E_WORKSPACE: process.env.WINCODE_E2E_WORKSPACE,
	WINCODE_LOCAL_DB_PATH: process.env.WINCODE_LOCAL_DB_PATH,
	WINCODE_MODEL_PRICING_OFFLINE: process.env.WINCODE_MODEL_PRICING_OFFLINE,
};

const restoreEnvironment = (): void => {
	for (const [key, value] of Object.entries(previousEnvironment)) {
		if (isUndefined(value)) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
};

process.env.WINCODE_MODEL_PRICING_OFFLINE = "true";

import { afterAll, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestRendererSetup } from "@opentui/core/testing";
import type {
	AgentTurn,
	AgentTurnEvent,
	SessionRecord,
	ToolCallId,
	ToolCallOutput,
} from "@wincode/agent-core";
import { act } from "react";
import type { FakeTurnScript } from "@/test/support/e2e-fake-runtime";
import {
	createFakeAiSdkModule,
	createFakeAiSdkRecorder,
} from "@/test/support/e2e-fake-runtime";
import { agentId, modelStepId, toolCallId } from "../support/identifiers";

const testDirectory = await mkdtemp(join(tmpdir(), "wincode-delegation-e2e-"));
process.env.WINCODE_LOCAL_DB_PATH = join(testDirectory, "conversation.sqlite");
process.env.WINCODE_E2E_HOME = testDirectory;
process.env.WINCODE_E2E_WORKSPACE = testDirectory;
afterAll(async () => {
	mock.restore();
	restoreEnvironment();
	await rm(testDirectory, { force: true, recursive: true });
});

const SUBAGENT = agentId("scout");
const FIRST_TASK = "first subagent task";
const SECOND_TASK = "second subagent task";
const FIRST_CALL = toolCallId("delegate-1");
const SECOND_CALL = toolCallId("delegate-2");
const PARENT_BEFORE = "parent before delegation";
const PARENT_AFTER = "parent after delegation";
const SUBAGENT_LINE = /Subagent (\S+)/u;
/** A subagent-role Agent is what arms the `delegate` Tool on the parent turn. */
const CONFIG_DOCUMENT = `{
	"agents": {
		"scout": { "description": "Explore and report findings", "role": "subagent" }
	}
}`;

type TurnGate = {
	/** Resolves once the turn has streamed and is waiting to be ended. */
	reached: Promise<void>;
	promise: Promise<void>;
	markReached: () => void;
	release: () => void;
};

const gates = new Map<string, TurnGate>();

/** Holds one turn open until the journey ends it. */
const turnGate = (task: string): TurnGate => {
	const existing = gates.get(task);
	if (!isUndefined(existing)) {
		return existing;
	}
	let markReached: () => void = () => undefined;
	let release: () => void = () => undefined;
	const reached = new Promise<void>((resolve) => {
		markReached = resolve;
	});
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	const gate = { markReached, promise, reached, release };
	gates.set(task, gate);
	return gate;
};

const childGate = (task: string): TurnGate => turnGate(task);

/** Holds the parent turn open once both Subagent executions have ended. */
const parentGate = turnGate("parent turn");

/**
 * Settles the UI until two consecutive renders agree, so an execution that
 * ended during an earlier pass is reflected in the frame the journey asserts.
 */
const settleUntilStable = async (setup: TestRendererSetup): Promise<string> => {
	let previous = "";
	for (let pass = 0; pass < 10; pass += 1) {
		await settleSessionUi(setup);
		const frame = setup.captureCharFrame();
		if (frame === previous) {
			return frame;
		}
		previous = frame;
	}
	return previous;
};

const textOf = (turn: AgentTurn): string =>
	turn.input.messages
		.flatMap((message) =>
			message.parts.map((part) => ("text" in part ? part.text : ""))
		)
		.join("\n");

const createTurnEvents = (turn: AgentTurn) => {
	let sequence = 0;
	const stepId = modelStepId("e2e-step");
	const next = () => {
		sequence += 1;
		return sequence - 1;
	};
	return {
		completed: (): AgentTurnEvent => ({
			finishedAt: Date.now(),
			sequence: next(),
			turnId: turn.id,
			type: "agent-turn-completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		}),
		started: (): AgentTurnEvent => ({
			agentId: turn.agent.id,
			sequence: next(),
			startedAt: Date.now(),
			turnId: turn.id,
			type: "agent-turn-started",
		}),
		stepFinished: (): AgentTurnEvent => ({
			modelId: turn.model.modelId,
			sequence: next(),
			stepId,
			turnId: turn.id,
			type: "model-step-finished",
			usage: { inputTokens: 1, outputTokens: 1 },
		}),
		stepStarted: (): AgentTurnEvent => ({
			modelId: turn.model.modelId,
			sequence: next(),
			stepId,
			turnId: turn.id,
			type: "model-step-started",
		}),
		text: (delta: string): AgentTurnEvent => ({
			delta,
			sequence: next(),
			turnId: turn.id,
			type: "text-delta",
		}),
		toolFinished: (
			callId: ToolCallId,
			outcome: ToolCallOutput
		): AgentTurnEvent => ({
			outcome,
			sequence: next(),
			toolCallId: callId,
			toolName: "delegate",
			turnId: turn.id,
			type: "tool-call-finished",
		}),
		toolStarted: (callId: ToolCallId, input: unknown): AgentTurnEvent => ({
			input,
			sequence: next(),
			toolCallId: callId,
			toolName: "delegate",
			turnId: turn.id,
			type: "tool-call-started",
		}),
	};
};

/**
 * The parent turn delegates to two Subagents at once, the way the Agent
 * Runtime executes two concurrent `delegate` Tool Calls, and streams again once
 * both return. Each turn streams its text and then waits, so the journey
 * decides when a Subagent execution and the parent turn end.
 */
const delegationScript: FakeTurnScript = async function* (
	turn,
	recorder
): AsyncGenerator<AgentTurnEvent> {
	recorder.requests.push({
		kind: "chat",
		messages: turn.input.messages.map((message) => ({
			id: message.id,
			role: message.role,
			text: textOf(turn),
		})),
	});
	const events = createTurnEvents(turn);
	yield events.started();
	yield events.stepStarted();
	if (!isUndefined(turn.delegation)) {
		const task = textOf(turn);
		yield events.text(`subagent output for ${task}`);
		yield events.stepFinished();
		childGate(task).markReached();
		await childGate(task).promise;
		yield events.completed();
		return;
	}
	const delegate = turn.tools?.find(
		({ definition }) => definition.name === "delegate"
	);
	if (isUndefined(delegate)) {
		throw new Error("The parent turn was not armed with the delegate Tool.");
	}
	yield events.text(PARENT_BEFORE);
	const calls = [
		{ callId: FIRST_CALL, task: FIRST_TASK },
		{ callId: SECOND_CALL, task: SECOND_TASK },
	];
	for (const { callId, task } of calls) {
		yield events.toolStarted(callId, { agent: SUBAGENT, prompt: task });
	}
	const outputs = await Promise.all(
		calls.map(({ callId, task }) =>
			delegate.execute(
				{ input: { agent: SUBAGENT, prompt: task }, toolCallId: callId },
				{}
			)
		)
	);
	for (const [index, { callId }] of calls.entries()) {
		const output = outputs[index];
		if (isUndefined(output)) {
			throw new Error("A delegated Tool Call returned no outcome.");
		}
		yield events.toolFinished(callId, output);
	}
	parentGate.markReached();
	await parentGate.promise;
	yield events.stepFinished();
	yield events.stepStarted();
	yield events.text(PARENT_AFTER);
	yield events.stepFinished();
	yield events.completed();
};

const recorder = createFakeAiSdkRecorder();
await mock.module("@wincode/agent-runtime-ai-sdk", () =>
	createFakeAiSdkModule(recorder, delegationScript)
);

// The module mock must be installed before the production SessionView graph loads.
const {
	cleanupSessionRender,
	createE2ePricing,
	createE2eStore,
	renderSession,
	seedCompactionHistory,
	settleSessionUi,
	writeE2EFrame,
} = await import("@/test/support/e2e-fixture");

const delegatedRecords = (
	records: readonly SessionRecord[],
	callId: ToolCallId
): readonly SessionRecord[] =>
	records.filter((record) => record.delegation?.parentToolCallId === callId);

const textOfCall = (callId: ToolCallId): string =>
	callId === FIRST_CALL ? FIRST_TASK : SECOND_TASK;

test("keeps the parent's live view while a Subagent streams and ends", async () => {
	const store = createE2eStore();
	const { messages, sessionId } = await seedCompactionHistory(store, 1);
	const waitForRecords = async (
		callId: ToolCallId,
		minimum: number
	): Promise<void> => {
		await setup?.waitFor(
			async () =>
				delegatedRecords(await store.listSessionRecords(sessionId), callId)
					.length >= minimum,
			{ maxPasses: 200 }
		);
	};
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			configDocument: CONFIG_DOCUMENT,
			initialMessages: messages,
			pricing: createE2ePricing(200_000),
			sessionId,
		});
		const activeSetup = rendered.setup;
		setup = activeSetup;
		await rendered.registryReady;
		await act(async () => {
			await activeSetup.flush();
			await activeSetup.flush();
		});

		await act(async () => {
			await activeSetup.mockInput.typeText("delegate the inspection");
		});
		await activeSetup.flush();
		activeSetup.mockInput.pressEnter();

		// Both Subagent executions stream while the parent is still running, and
		// each holds its turn open until the journey ends it. The journey proves
		// the view the user reads; the parent's own Session View State is asserted
		// at the engine seam.
		await childGate(FIRST_TASK).reached;
		await childGate(SECOND_TASK).reached;
		const whileBothStream = await settleUntilStable(activeSetup);
		expect(whileBothStream).toContain(PARENT_BEFORE);
		const liveSubagent = SUBAGENT_LINE.exec(whileBothStream)?.[1];
		expect(liveSubagent).toBeDefined();

		// The first Subagent ends while the second still streams: its own view is
		// dropped, and the session keeps showing the running Subagent's view. This
		// is the assertion that fails while executions share one view slot.
		childGate(FIRST_TASK).release();
		await waitForRecords(FIRST_CALL, 2);
		const whileSecondStreams = await settleUntilStable(activeSetup);
		expect(whileSecondStreams).toContain(PARENT_BEFORE);
		expect(SUBAGENT_LINE.exec(whileSecondStreams)?.[1]).toBe(liveSubagent);

		// With both Subagents ended, the session's live view is the parent's own
		// again — the turn is still running and nothing is delegated.
		childGate(SECOND_TASK).release();
		await waitForRecords(SECOND_CALL, 2);
		await parentGate.reached;
		const whileParentRuns = await settleUntilStable(activeSetup);
		expect(whileParentRuns).toContain("Esc interrupt");
		expect(whileParentRuns).not.toContain("Subagent ");

		// The parent streams again and finishes its own turn.
		parentGate.release();
		await activeSetup.waitFor(
			async () =>
				(await store.listSessionRecords(sessionId)).filter(
					(record) =>
						isUndefined(record.delegation) &&
						record.outcome.kind === "assistant"
				).length > 1,
			{ maxPasses: 200 }
		);
		const afterParentFinishes = await settleUntilStable(activeSetup);
		expect(afterParentFinishes).toContain(PARENT_BEFORE);
		expect(afterParentFinishes).toContain(PARENT_AFTER);
		expect(afterParentFinishes).not.toContain("Subagent ");

		// Each Subagent's records keep their parent linkage and its own output.
		const records = await store.listSessionRecords(sessionId);
		for (const callId of [FIRST_CALL, SECOND_CALL]) {
			const delegated = delegatedRecords(records, callId);
			const userRecord = delegated.find(
				(record) => record.outcome.kind === "user"
			);
			const assistantRecord = delegated.find(
				(record) => record.outcome.kind === "assistant"
			);
			expect(userRecord?.messages[0]?.parts[0]).toMatchObject({
				text: textOfCall(callId),
			});
			expect(assistantRecord?.messages[0]?.parts[0]).toMatchObject({
				text: `subagent output for ${textOfCall(callId)}`,
			});
			expect(assistantRecord?.delegation?.parentTurnId).toBeDefined();
		}
	} finally {
		if (setup) {
			writeE2EFrame(setup);
			setup.renderer.destroy();
		}
		cleanupSessionRender();
	}
});
