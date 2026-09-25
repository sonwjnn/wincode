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
	ModelStepRequest,
	ModelStreamPart,
} from "@wincode/ai/model-client";
import { act } from "react";
import type { FakeModelStepScript } from "@/test/support/e2e-fake-runtime";
import {
	createFakeModelClientModule,
	createFakeModelClientRecorder,
} from "@/test/support/e2e-fake-runtime";

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
 * The first turn is refused by the provider as a context overflow; continuation
 * after compaction answers normally, proving the Agent Runtime received the
 * updated Session Context.
 */
const overflowThenAnswer: FakeModelStepScript = async function* (
	request: ModelStepRequest,
	recorder
): AsyncGenerator<ModelStreamPart> {
	turnCount += 1;
	recorder.requests.push({
		kind: "chat",
		messages: request.messages.map((message) => ({
			role: message.role,
			text: message.content
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n"),
		})),
	});
	if (turnCount === 1) {
		yield { delta: "partial output", type: "text-delta" };
		throw new Error("The prompt exceeds the model context window.");
	}
	yield { delta: "E2E chat response", type: "text-delta" };
	yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
};

const recorder = createFakeModelClientRecorder();
await mock.module("@wincode/ai/model-client", () =>
	createFakeModelClientModule(recorder, overflowThenAnswer)
);

// The module mock must be installed before the production SessionView graph loads.
const {
	cleanupSessionRender,
	createE2ePricing,
	createE2eStore,
	renderSession,
	seedCompactionHistory,
	settleSessionUi,
	waitForSessionCondition,
	writeE2EFrame,
} = await import("@/test/support/e2e-fixture");

const store = createE2eStore();
const { sessionId } = await seedCompactionHistory(store);

const waitForChatRequestCount = async (count: number): Promise<void> => {
	await waitForSessionCondition(() => chatRequests().length >= count);
};

const chatRequests = () =>
	recorder.requests.filter((request) => request.kind === "chat");

test("continues the compacted Session Context after a provider context overflow", async () => {
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			configDocument: CONFIG_DOCUMENT,
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

		// The refused turn proposes recovery, which compacts eligible history
		// before continuing the existing Session Context.
		await waitForSessionCondition(
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

		// Context continuation runs outside the renderer scheduler, so poll its
		// recorder signal before waiting for the response frame.
		await waitForChatRequestCount(2);
		await settleSessionUi(activeSetup);
		await act(async () => {
			await activeSetup.waitForFrame(
				(frame) => frame.includes("E2E chat response"),
				{ maxPasses: 600 }
			);
		});

		const [refused, continued] = chatRequests();
		if (!(refused && continued)) {
			throw new Error("The refused and continued requests were not recorded.");
		}
		const refusedText = refused.messages.map(({ text }) => text).join("\n");
		const continuedText = continued.messages.map(({ text }) => text).join("\n");
		expect(refusedText).toContain(PROMPT);
		expect(refusedText).not.toContain(recorder.summaryText);
		expect(continuedText).toContain(PROMPT);
		expect(continuedText).toContain(recorder.summaryText);
		expect(continuedText).not.toContain("partial output");

		// Recovery compacts once and continues once. The prompt still has one
		// durable user message, and the overflow attempt is not repeated.
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
