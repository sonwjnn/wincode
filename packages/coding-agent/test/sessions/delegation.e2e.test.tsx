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
import type { SessionRecord, ToolCallId } from "@wincode/agent-core";
import type {
	ModelStepRequest,
	ModelStreamPart,
} from "@wincode/ai/model-client";
import { act } from "react";
import type { FakeModelStepScript } from "@/test/support/e2e-fake-runtime";
import {
	createFakeModelClientModule,
	createFakeModelClientRecorder,
} from "@/test/support/e2e-fake-runtime";
import { agentId, toolCallId } from "../support/identifiers";

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
	const reached = Promise.withResolvers<void>();
	const completion = Promise.withResolvers<void>();
	const gate = {
		markReached: () => reached.resolve(undefined),
		promise: completion.promise,
		reached: reached.promise,
		release: () => completion.resolve(undefined),
	};
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

const latestUserText = (request: ModelStepRequest): string => {
	const latestUserMessage = request.messages
		.filter((message) => message.role === "user")
		.at(-1);
	return (
		latestUserMessage?.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n") ?? ""
	);
};

/**
 * The parent emits two concurrent Tool Calls. Child and parent streams pause at
 * the same gates as the user-visible journey, but the Agent Runtime owns calls.
 */
const delegationScript: FakeModelStepScript = async function* (
	request: ModelStepRequest,
	recorder
): AsyncGenerator<ModelStreamPart> {
	recorder.requests.push({
		kind: "chat",
		messages: request.messages.map((message) => ({
			role: message.role,
			text: message.content
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n"),
		})),
	});
	const prompt = latestUserText(request);
	const childTask = [FIRST_TASK, SECOND_TASK].find((task) =>
		prompt.includes(task)
	);
	if (childTask) {
		yield {
			delta: `subagent output for ${childTask}`,
			type: "text-delta",
		};
		const gate = childGate(childTask);
		gate.markReached();
		await gate.promise;
		yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
		return;
	}
	const hasDelegationResults = request.messages.some((message) =>
		message.content.some(
			(part) =>
				part.type === "tool-result" &&
				(part.toolCallId === FIRST_CALL || part.toolCallId === SECOND_CALL)
		)
	);
	if (hasDelegationResults) {
		parentGate.markReached();
		await parentGate.promise;
		yield { delta: PARENT_AFTER, type: "text-delta" };
		yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
		return;
	}
	yield { delta: PARENT_BEFORE, type: "text-delta" };
	yield {
		input: { agent: SUBAGENT, prompt: FIRST_TASK },
		toolCallId: FIRST_CALL,
		toolName: "delegate",
		type: "tool-call",
	};
	yield {
		input: { agent: SUBAGENT, prompt: SECOND_TASK },
		toolCallId: SECOND_CALL,
		toolName: "delegate",
		type: "tool-call",
	};
	yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
};

const recorder = createFakeModelClientRecorder();
await mock.module("@wincode/ai/model-client", () =>
	createFakeModelClientModule(recorder, delegationScript)
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
	const { sessionId } = await seedCompactionHistory(store, 1);
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
