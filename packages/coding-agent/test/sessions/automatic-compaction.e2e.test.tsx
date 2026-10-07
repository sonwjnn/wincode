import { isUndefined } from "@wincode/utils";

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
import { act } from "react";
import { setInteractiveRuntimeContext } from "@/shared/runtime-context";
import {
	createFakeModelClient,
	createFakeModelClientModule,
	createFakeModelClientRecorder,
	type FakeModelStepScript,
} from "@/test/support/e2e-fake-runtime";
import { sessionMessageId } from "../support/identifiers";

const testDirectory = await mkdtemp(
	join(tmpdir(), "wincode-automatic-compaction-e2e-")
);
process.env.WINCODE_LOCAL_DB_PATH = join(testDirectory, "conversation.sqlite");
process.env.WINCODE_E2E_HOME = testDirectory;
process.env.WINCODE_E2E_WORKSPACE = testDirectory;
setInteractiveRuntimeContext({ args: [], cwd: testDirectory });
afterAll(async () => {
	mock.restore();
	restoreEnvironment();
	await rm(testDirectory, { force: true, recursive: true });
});

const recorder = createFakeModelClientRecorder();
let pausedStep: PromiseWithResolvers<void> | undefined;
const pauseNextStep = (): (() => void) => {
	const gate = Promise.withResolvers<void>();
	pausedStep = gate;
	return gate.resolve;
};
const controlledStep: FakeModelStepScript = async function* (
	request,
	recorder
) {
	const gate = pausedStep;
	pausedStep = undefined;
	for await (const part of createFakeModelClient(recorder).stream(request)) {
		yield part;
		if (part.type === "text-delta" && gate) {
			await gate.promise;
		}
	}
};
await mock.module("@wincode/ai/model-client", () =>
	createFakeModelClientModule(recorder, controlledStep)
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
	waitForSessionFrame,
	writeE2EFrame,
} = await import("@/test/support/e2e-fixture");

const store = createE2eStore();
const { sessionId } = await seedCompactionHistory(store);

test("compacts automatically before sending and uses the rebuilt context", async () => {
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			pricing: createE2ePricing(12_000),
			sessionId,
		});
		const activeSetup = rendered.setup;
		setup = activeSetup;
		await rendered.registryReady;
		await waitForSessionFrame(activeSetup, (frame) =>
			frame.includes("Ask anything")
		);

		await act(async () => {
			await activeSetup.mockInput.typeText(
				"continue with the retained context"
			);
			await activeSetup.flush();
			activeSetup.mockInput.pressEnter();
		});

		await waitForSessionCondition(
			async () => (await store.getCompactions(sessionId)).length > 0
		);
		await waitForSessionFrame(activeSetup, (frame) =>
			frame.includes("Compacted (automatic)")
		);

		await waitForSessionCondition(() =>
			recorder.requests.some((request) => request.kind === "chat")
		);
		await waitForSessionFrame(activeSetup, (frame) =>
			frame.includes("E2E chat response")
		);

		const compactions = await store.getCompactions(sessionId);
		expect(compactions).toHaveLength(1);
		const entry = compactions[0];
		if (!entry) {
			throw new Error("The automatic compaction entry was not persisted.");
		}
		expect(entry.trigger).toBe("threshold");
		expect(entry.summary.text).toBe(recorder.summaryText);
		expect(entry.summary.coveredMessageIds).toContain(
			sessionMessageId("user-1")
		);

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

const QUEUED_CORRECTION = /queued\s+queued correction/u;
const STEERING_CORRECTION = /steering\s+queued correction/u;
const WAITING_COUNT_PATTERN = /\d+ waiting/u;

test("busy composer queues a prompt until empty Enter promotes it into the same turn", async () => {
	const seeded = await seedCompactionHistory(store, 1, "input-lane");
	const requestOffset = recorder.requests.length;
	const release = pauseNextStep();
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			pricing: createE2ePricing(100_000),
			sessionId: seeded.sessionId,
		});
		const activeSetup = rendered.setup;
		setup = activeSetup;
		await rendered.registryReady;
		await waitForSessionFrame(activeSetup, (frame) =>
			frame.includes("Ask anything")
		);
		const submit = async (text: string): Promise<void> => {
			await act(async () => {
				await activeSetup.mockInput.typeText(text);
				await activeSetup.flush();
				activeSetup.mockInput.pressEnter();
			});
			await settleSessionUi(activeSetup);
		};
		await submit("original live request");
		await waitForSessionFrame(activeSetup, (frame) =>
			frame.includes("E2E chat response")
		);
		await submit("queued correction");
		await settleSessionUi(activeSetup);

		const queuedFrame = activeSetup.captureCharFrame();
		expect(queuedFrame).toMatch(QUEUED_CORRECTION);
		expect(queuedFrame).not.toMatch(STEERING_CORRECTION);
		expect(
			recorder.requests
				.slice(requestOffset)
				.filter(({ kind }) => kind === "chat")
		).toHaveLength(1);

		await act(async () => {
			activeSetup.mockInput.pressEnter();
			await activeSetup.flush();
		});
		await waitForSessionFrame(
			activeSetup,
			(frame) =>
				frame.includes("queued correction") && !QUEUED_CORRECTION.test(frame)
		);
		const steeredFrame = activeSetup.captureCharFrame();
		expect(steeredFrame).toContain("queued correction");
		expect(steeredFrame).not.toMatch(QUEUED_CORRECTION);
		expect(steeredFrame).not.toMatch(WAITING_COUNT_PATTERN);
		expect(
			recorder.requests
				.slice(requestOffset)
				.filter(({ kind }) => kind === "chat")
		).toHaveLength(1);

		release();
		await waitForSessionFrame(
			activeSetup,
			(frame) =>
				!frame.includes("1 waiting") &&
				recorder.requests
					.slice(requestOffset)
					.filter(({ kind }) => kind === "chat").length === 2
		);
		await waitForSessionCondition(async () =>
			(await store.listSessionRecords(seeded.sessionId)).some(
				(record) =>
					record.outcome.kind === "assistant" &&
					record.messages.some(
						(message) =>
							message.metadata?.sourceUserMessageId !== undefined &&
							message.metadata.sourceUserMessageId !==
								sessionMessageId("input-lane-user-1")
					)
			)
		);
		const records = await store.listSessionRecords(seeded.sessionId);
		const correction = records.find((record) =>
			record.messages.some(
				(message) =>
					message.role === "user" &&
					message.parts.some(
						(part) => part.type === "text" && part.text === "queued correction"
					)
			)
		);
		const terminal = records.find(
			(record) =>
				record.outcome.kind === "assistant" &&
				record.turnId === correction?.turnId
		);
		expect(correction?.messages[0]?.metadata?.joinedTurnId).toBe(
			terminal?.turnId
		);
		expect(
			terminal?.messages.some((message) => message.role === "assistant")
		).toBe(true);
		const chats = recorder.requests
			.slice(requestOffset)
			.filter((request) => request.kind === "chat");
		expect(
			chats[1]?.messages.filter(({ role }) => role === "user").at(-1)?.text
		).toBe("queued correction");
	} finally {
		release();
		pausedStep = undefined;
		if (setup) {
			setup.renderer.destroy();
		}
		cleanupSessionRender();
	}
});
