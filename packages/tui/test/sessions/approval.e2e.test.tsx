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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { modelStepId, toolCallId } from "../support/identifiers";

const testDirectory = await mkdtemp(join(tmpdir(), "wincode-approval-e2e-"));
const previousWorkingDirectory = process.cwd();
process.env.WINCODE_LOCAL_DB_PATH = join(testDirectory, "conversation.sqlite");
process.env.WINCODE_E2E_HOME = testDirectory;
process.env.WINCODE_E2E_WORKSPACE = testDirectory;
// The coding Tools resolve relative paths against the process working
// directory, so the workspace is also the workspace the Tools run in.
process.chdir(testDirectory);
afterAll(async () => {
	mock.restore();
	process.chdir(previousWorkingDirectory);
	restoreEnvironment();
	await rm(testDirectory, { force: true, recursive: true });
});

const READ_CALL = toolCallId("read-approval-1");
/** The turn a journey ends by unmounting carries its own Tool Call Identifiers. */
const UNMOUNT_CALL = toolCallId("read-approval-unmount");
/** Its second call asks for approval only after the session has gone away. */
const AFTER_UNMOUNT_CALL = toolCallId("read-approval-after-unmount");
const FILE_NAME = "notes.txt";
const FILE_CONTENT = "approval journey notes";
/** The read Tool is approval-gated for this journey. */
const CONFIG_DOCUMENT = `{
	"agents": { "build": { "permission": { "read": "ask" } } }
}`;

const textOf = (turn: AgentTurn): string =>
	turn.input.messages
		.flatMap((message) =>
			message.parts.map((part) => ("text" in part ? part.text : ""))
		)
		.join("\n");

/** The Tool Call Identifiers of the turn a journey started. */
const callIdsForTurn = (turn: AgentTurn): readonly ToolCallId[] =>
	textOf(turn).includes("again")
		? [UNMOUNT_CALL, AFTER_UNMOUNT_CALL]
		: [READ_CALL];

/**
 * The settled outcome of each journey's gated Tool Call, recorded where it
 * lands — including when the session is gone before the user answers it.
 */
const gatedOutcomes = new Map<ToolCallId, ToolCallOutput>();

/**
 * The turn calls the approval-gated read Tool and only streams its answer once
 * the Tool Gate has settled: the panel the journey answers is the same
 * evaluation the Agent Runtime is waiting on.
 */
const approvalScript: FakeTurnScript = async function* (
	turn,
	recorder
): AsyncGenerator<AgentTurnEvent> {
	let sequence = 0;
	const next = () => {
		sequence += 1;
		return sequence - 1;
	};
	const stepId = modelStepId("approval-step");
	const callIds = callIdsForTurn(turn);
	recorder.requests.push({
		kind: "chat",
		messages: turn.input.messages.map((message) => ({
			id: message.id,
			role: message.role,
			text: textOf(turn),
		})),
	});
	yield {
		agentId: turn.agent.id,
		sequence: next(),
		startedAt: Date.now(),
		turnId: turn.id,
		type: "agent-turn-started",
	};
	yield {
		modelId: turn.model.modelId,
		sequence: next(),
		stepId,
		turnId: turn.id,
		type: "model-step-started",
	};
	const read = turn.tools?.find(({ definition }) => definition.name === "read");
	if (isUndefined(read)) {
		throw new Error("The turn was not armed with the read Tool.");
	}
	for (const callId of callIds) {
		yield {
			input: { path: FILE_NAME },
			sequence: next(),
			toolCallId: callId,
			toolName: "read",
			turnId: turn.id,
			type: "tool-call-started",
		};
	}
	// The calls run in order, and no event is emitted between them: a turn that
	// outlives its session asks for its second approval only after the first has
	// settled, which is how the unmount journey reaches the shut-down session.
	const outcomes: ToolCallOutput[] = [];
	for (const callId of callIds) {
		const outcome: ToolCallOutput = await read.execute(
			{ input: { path: FILE_NAME }, toolCallId: callId },
			{}
		);
		gatedOutcomes.set(callId, outcome);
		outcomes.push(outcome);
	}
	for (const [index, callId] of callIds.entries()) {
		yield {
			outcome: outcomes[index] as ToolCallOutput,
			sequence: next(),
			toolCallId: callId,
			toolName: "read",
			turnId: turn.id,
			type: "tool-call-finished",
		};
	}
	yield {
		delta: "Notes read.",
		sequence: next(),
		turnId: turn.id,
		type: "text-delta",
	};
	yield {
		modelId: turn.model.modelId,
		sequence: next(),
		stepId,
		turnId: turn.id,
		type: "model-step-finished",
		usage: { inputTokens: 1, outputTokens: 1 },
	};
	yield {
		finishedAt: Date.now(),
		sequence: next(),
		turnId: turn.id,
		type: "agent-turn-completed",
		usage: { inputTokens: 1, outputTokens: 1 },
	};
};

const recorder = createFakeAiSdkRecorder();
await mock.module("@wincode/agent-runtime-ai-sdk", () =>
	createFakeAiSdkModule(recorder, approvalScript)
);

// The module mock must be installed before the production SessionView graph loads.
const {
	cleanupSessionRender,
	createE2ePricing,
	createE2eStore,
	renderSession,
	seedCompactionHistory,
	waitForSessionCondition,
	waitForSessionFrame,
	writeE2EFrame,
} = await import("@/test/support/e2e-fixture");

const store = createE2eStore();
const { messages, sessionId } = await seedCompactionHistory(store, 1);
await writeFile(join(testDirectory, FILE_NAME), FILE_CONTENT, "utf8");

const completedToolRecords = (
	records: readonly SessionRecord[],
	callId: ToolCallId
): readonly SessionRecord[] =>
	records.filter(
		(record) =>
			record.outcome.kind === "tool" &&
			record.messages.some((message) =>
				message.parts.some(
					(part) => part.type === "tool-call" && part.toolCallId === callId
				)
			)
	);

/**
 * Waits on time for the gated evaluation, which outlives the destroyed view.
 */
const waitForGatedOutcome = async (
	callId: ToolCallId
): Promise<ToolCallOutput> => {
	await waitForSessionCondition(() => !isUndefined(gatedOutcomes.get(callId)));
	const outcome = gatedOutcomes.get(callId);
	if (isUndefined(outcome)) {
		throw new Error("The gated Tool Call evaluation never settled.");
	}
	return outcome;
};

const renderApprovalJourney = async (): Promise<TestRendererSetup> => {
	const rendered = await renderSession({
		configDocument: CONFIG_DOCUMENT,
		initialTranscript: messages,
		pricing: createE2ePricing(200_000),
		sessionId,
	});
	const { setup } = rendered;
	await rendered.registryReady;
	await act(async () => {
		await setup.flush();
		await setup.flush();
	});
	return setup;
};

const submitPrompt = async (
	setup: TestRendererSetup,
	prompt: string
): Promise<void> => {
	await act(async () => {
		await setup.mockInput.typeText(prompt);
	});
	await setup.flush();
	setup.mockInput.pressEnter();
};

test("answers a pending approval and the gated Tool Call runs", async () => {
	const setup = await renderApprovalJourney();
	try {
		await submitPrompt(setup, "read the notes");

		// The Tool Gate evaluation is waiting: the session projects the request
		// into the panel the user answers.
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("Permission required")
		);
		const pendingFrame = setup.captureCharFrame();
		expect(pendingFrame).toContain("notes.txt");
		expect(pendingFrame).toContain("Allow once");

		// Enter answers the pending approval through the session's command.
		setup.mockInput.pressEnter();
		await waitForSessionFrame(setup, (frame) => frame.includes("allowed once"));
		await waitForSessionFrame(setup, (frame) => frame.includes("Notes read."));
		const settledFrame = setup.captureCharFrame();
		expect(settledFrame).not.toContain("Permission required");

		// The approved Tool Call ran and its result is durable.
		const [record] = completedToolRecords(
			await store.listSessionRecords(sessionId),
			READ_CALL
		);
		expect(JSON.stringify(record?.messages)).toContain(FILE_CONTENT);
	} finally {
		writeE2EFrame(setup);
		setup.renderer.destroy();
		cleanupSessionRender();
	}
});

test("settles an approval left pending when the session view unmounts", async () => {
	const setup = await renderApprovalJourney();
	try {
		await submitPrompt(setup, "read the notes again");
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("Permission required")
		);

		// The view goes away with the decision still owed. The waiting evaluation
		// settles through the session's shutdown, and the turn's next approval
		// request — which arrives after the session is gone — settles too, so no
		// approval is left outstanding and no Tool Call runs behind the user's
		// back.
		writeE2EFrame(setup);
		setup.renderer.destroy();
		const settled = await waitForGatedOutcome(UNMOUNT_CALL);
		const afterShutdown = await waitForGatedOutcome(AFTER_UNMOUNT_CALL);

		expect(settled.type).toBe("failure");
		expect(afterShutdown.type).toBe("failure");
		expect(JSON.stringify([settled, afterShutdown])).not.toContain(
			FILE_CONTENT
		);
		const records = await store.listSessionRecords(sessionId);
		expect(completedToolRecords(records, UNMOUNT_CALL)).toHaveLength(0);
		expect(completedToolRecords(records, AFTER_UNMOUNT_CALL)).toHaveLength(0);
	} finally {
		cleanupSessionRender();
	}
});
