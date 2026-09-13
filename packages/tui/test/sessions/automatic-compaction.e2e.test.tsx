const previousEnvironment = {
	WINCODE_E2E_HOME: process.env.WINCODE_E2E_HOME,
	WINCODE_E2E_WORKSPACE: process.env.WINCODE_E2E_WORKSPACE,
	WINCODE_LOCAL_DB_PATH: process.env.WINCODE_LOCAL_DB_PATH,
	WINCODE_MODEL_PRICING_OFFLINE: process.env.WINCODE_MODEL_PRICING_OFFLINE,
};

const restoreEnvironment = (): void => {
	for (const [key, value] of Object.entries(previousEnvironment)) {
		if (value === undefined) {
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
import { act } from "react";
import {
	createFakeAiSdkModule,
	createFakeAiSdkRecorder,
} from "@/test/support/e2e-fake-runtime";

const testDirectory = await mkdtemp(
	join(tmpdir(), "wincode-automatic-compaction-e2e-")
);
process.env.WINCODE_LOCAL_DB_PATH = join(testDirectory, "conversation.sqlite");
process.env.WINCODE_E2E_HOME = testDirectory;
process.env.WINCODE_E2E_WORKSPACE = testDirectory;
afterAll(async () => {
	mock.restore();
	restoreEnvironment();
	await rm(testDirectory, { force: true, recursive: true });
});

const recorder = createFakeAiSdkRecorder();
await mock.module("@wincode/agent-runtime-ai-sdk", () =>
	createFakeAiSdkModule(recorder)
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

test("compacts automatically before sending and uses the rebuilt context", async () => {
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			initialMessages: messages,
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
			await activeSetup.mockInput.typeText(
				"continue with the retained context"
			);
		});
		await activeSetup.flush();
		activeSetup.mockInput.pressEnter();

		await activeSetup.waitFor(
			async () => (await store.getCompactions(sessionId)).length > 0,
			{ maxPasses: 200 }
		);
		await settleSessionUi(activeSetup);
		await act(async () => {
			await activeSetup.waitForFrame(
				(frame) => frame.includes("Compacted (automatic)"),
				{ maxPasses: 200 }
			);
		});

		await activeSetup.waitFor(
			() => recorder.requests.some((request) => request.kind === "chat"),
			{ maxPasses: 200 }
		);
		await settleSessionUi(activeSetup);
		await act(async () => {
			await activeSetup.waitForFrame(
				(frame) => frame.includes("E2E chat response"),
				{ maxPasses: 200 }
			);
		});

		const compactions = await store.getCompactions(sessionId);
		expect(compactions).toHaveLength(1);
		const entry = compactions[0];
		if (!entry) {
			throw new Error("The automatic compaction entry was not persisted.");
		}
		expect(entry.trigger).toBe("threshold");
		expect(entry.summary.text).toBe(recorder.summaryText);
		expect(entry.summary.coveredMessageIds).toContain("user-1");

		const summaryRequests = recorder.requests.filter(
			(request) => request.kind === "summary"
		);
		expect(summaryRequests).toHaveLength(1);
		const summaryRequest = summaryRequests[0];
		if (!summaryRequest || summaryRequest.kind !== "summary") {
			throw new Error("The summary provider was not called.");
		}
		const chatRequests = recorder.requests.filter(
			(request) => request.kind === "chat"
		);
		expect(chatRequests).toHaveLength(1);
		const chatRequest = chatRequests[0];
		if (!chatRequest || chatRequest.kind !== "chat") {
			throw new Error("The post-compaction chat request was not recorded.");
		}
		expect(recorder.requests.indexOf(summaryRequest)).toBeLessThan(
			recorder.requests.indexOf(chatRequest)
		);
		const requestText = chatRequest.messages.map(({ text }) => text).join("\n");
		expect(requestText).toContain(entry.summary.text);
		expect(requestText).toContain("retained-turn-10");
		expect(requestText).not.toContain("compacted-turn-1 context");
	} finally {
		if (setup) {
			writeE2EFrame(setup);
			setup.renderer.destroy();
		}
		cleanupSessionRender();
	}
});
