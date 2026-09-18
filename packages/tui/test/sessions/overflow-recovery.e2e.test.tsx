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
import { setTimeout as delay } from "node:timers/promises";
import type { TestRendererSetup } from "@opentui/core/testing";
import { createOperationalFailure } from "@wincode/agent-core";
import { act } from "react";
import type { FakeTurnScript } from "@/test/support/e2e-fake-runtime";
import {
	createFakeAiSdkModule,
	createFakeAiSdkRecorder,
} from "@/test/support/e2e-fake-runtime";
import { modelStepId } from "../support/identifiers";

const testDirectory = await mkdtemp(
	join(tmpdir(), "wincode-overflow-recovery-e2e-")
);
process.env.WINCODE_LOCAL_DB_PATH = join(testDirectory, "conversation.sqlite");
process.env.WINCODE_E2E_HOME = testDirectory;
process.env.WINCODE_E2E_WORKSPACE = testDirectory;
afterAll(async () => {
	mock.restore();
	restoreEnvironment();
	await rm(testDirectory, { force: true, recursive: true });
});

const PROMPT = "continue after the overflow";
/**
 * The seeded history fits the threshold but not the retained tail, so the send
 * itself does not compact and the recovery's compaction has a cut point.
 */
const CONFIG_DOCUMENT = `{
	"compaction": { "keepRecentTokens": 1000, "reserveTokens": 2000 }
}`;
let turnCount = 0;

/**
 * The first turn is refused by the provider as a context overflow; the turn the
 * recovery replays answers normally, so the journey proves the replay ran on
 * the compacted Session Context.
 */
const overflowThenAnswer: FakeTurnScript = async function* (turn, recorder) {
	turnCount += 1;
	recorder.requests.push({
		kind: "chat",
		messages: turn.input.messages.map((message) => ({
			id: message.id,
			role: message.role,
			text: message.parts
				.map((part) => ("text" in part ? part.text : ""))
				.join("\n"),
		})),
	});
	yield {
		agentId: turn.agent.id,
		sequence: 0,
		startedAt: 1,
		turnId: turn.id,
		type: "agent-turn-started",
	};
	yield {
		modelId: turn.model.modelId,
		sequence: 1,
		stepId: modelStepId("e2e-step"),
		turnId: turn.id,
		type: "model-step-started",
	};
	if (turnCount === 1) {
		yield {
			delta: "partial output",
			sequence: 2,
			turnId: turn.id,
			type: "text-delta",
		};
		yield {
			failure: createOperationalFailure({
				code: "context-overflow",
				details: {
					modelId: turn.model.modelId,
					providerId: turn.model.providerId,
				},
				retry: "with-changes",
				source: "model",
			}),
			finishedAt: 2,
			sequence: 3,
			turnId: turn.id,
			type: "agent-turn-failed",
		};
		return;
	}
	yield {
		delta: "E2E chat response",
		sequence: 2,
		turnId: turn.id,
		type: "text-delta",
	};
	yield {
		modelId: turn.model.modelId,
		sequence: 3,
		stepId: modelStepId("e2e-step"),
		turnId: turn.id,
		type: "model-step-finished",
		usage: { inputTokens: 1, outputTokens: 1 },
	};
	yield {
		finishedAt: 2,
		sequence: 4,
		turnId: turn.id,
		type: "agent-turn-completed",
		usage: { inputTokens: 1, outputTokens: 1 },
	};
};

const recorder = createFakeAiSdkRecorder();
await mock.module("@wincode/agent-runtime-ai-sdk", () =>
	createFakeAiSdkModule(recorder, overflowThenAnswer)
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

const store = createE2eStore();
const { messages, sessionId } = await seedCompactionHistory(store);

const waitForCondition = async (
	predicate: () => boolean | Promise<boolean>
): Promise<void> => {
	const deadline = Date.now() + 5000;
	while (!(await predicate())) {
		if (Date.now() >= deadline) {
			throw new Error("Timed out waiting for the recovery condition.");
		}
		await delay(10);
	}
};

const waitForChatRequestCount = async (count: number): Promise<void> => {
	await waitForCondition(() => chatRequests().length >= count);
};

const chatRequests = () =>
	recorder.requests.filter((request) => request.kind === "chat");

test("compacts and replays the prompt after a provider context overflow", async () => {
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			configDocument: CONFIG_DOCUMENT,
			initialTranscript: messages,
			pricing: createE2ePricing(12_000),
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
			await activeSetup.mockInput.typeText(PROMPT);
		});
		await activeSetup.flush();
		activeSetup.mockInput.pressEnter();

		// The refused turn proposes the recovery, which compacts the replay-safe
		// history before it replays the prompt.
		await waitForCondition(
			async () => (await store.getCompactions(sessionId)).length > 0
		);
		const compactions = await store.getCompactions(sessionId);
		expect(compactions).toHaveLength(1);
		const entry = compactions[0];
		if (!entry) {
			throw new Error("The overflow compaction entry was not persisted.");
		}
		expect(entry.trigger).toBe("overflow");
		expect(entry.summary.text).toBe(recorder.summaryText);

		// The replay runs outside the renderer scheduler, so poll its recorder
		// signal before waiting for the response frame.
		await waitForChatRequestCount(2);
		await settleSessionUi(activeSetup);
		await act(async () => {
			await activeSetup.waitForFrame(
				(frame) => frame.includes("E2E chat response"),
				{ maxPasses: 600 }
			);
		});

		const [refused, replayed] = chatRequests();
		if (!(refused && replayed)) {
			throw new Error("The refused and replayed requests were not recorded.");
		}
		const refusedText = refused.messages.map(({ text }) => text).join("\n");
		const replayedText = replayed.messages.map(({ text }) => text).join("\n");
		expect(refusedText).toContain(PROMPT);
		expect(refusedText).not.toContain(recorder.summaryText);
		expect(replayedText).toContain(PROMPT);
		expect(replayedText).toContain(recorder.summaryText);
		expect(replayedText).not.toContain("partial output");

		// The recovery compacted once and replayed the prompt once: the prompt
		// stays one user message, and the overflow attempt is not repeated.
		expect(
			recorder.requests.filter((request) => request.kind === "summary")
		).toHaveLength(1);
		const records = await store.listSessionRecords(sessionId);
		expect(
			records.filter((record) =>
				record.messages.some((message) =>
					message.parts.some(
						(part) => part.type === "text" && part.text === PROMPT
					)
				)
			)
		).toHaveLength(1);
	} finally {
		if (setup) {
			writeE2EFrame(setup);
			setup.renderer.destroy();
		}
		cleanupSessionRender();
	}
});
