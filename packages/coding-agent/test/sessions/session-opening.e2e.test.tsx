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
import { act } from "react";
import {
	createFakeModelClientModule,
	createFakeModelClientRecorder,
} from "@/test/support/e2e-fake-runtime";
import { agentId, agentTurnId, sessionMessageId } from "../support/identifiers";

const testDirectory = await mkdtemp(
	join(tmpdir(), "wincode-session-opening-e2e-")
);
process.env.WINCODE_LOCAL_DB_PATH = join(testDirectory, "conversation.sqlite");
process.env.WINCODE_E2E_HOME = testDirectory;
process.env.WINCODE_E2E_WORKSPACE = testDirectory;
afterAll(async () => {
	restoreEnvironment();
	await rm(testDirectory, { force: true, recursive: true });
});

const recorder = createFakeModelClientRecorder();
await mock.module("@wincode/ai/model-client", () =>
	createFakeModelClientModule(recorder)
);

// The module mock must be installed before the production Session Surface graph
// loads, so the Agent Runtime the Session Host composes is the fake one.
const {
	E2E_MODEL,
	cleanupSessionRender,
	createE2ePricing,
	createE2eStore,
	renderSession,
	seedCompactionHistory,
	settleSessionUi,
	waitForSessionFrame,
	writeE2EFrame,
} = await import("@/test/support/e2e-fixture");
const { buildUserSessionRecord } = await import(
	"@/modules/sessions/storage/session-record"
);
const { sessionId } = await import("../support/identifiers");

const store = createE2eStore();
const seeded = await seedCompactionHistory(store, 1);
const pendingMessage = {
	id: sessionMessageId("pending-user"),
	parts: [{ text: "start this turn", type: "text" as const }],
	role: "user" as const,
};
await store.commitSessionRecord({
	record: buildUserSessionRecord({
		agentId: agentId("build"),
		message: pendingMessage,
		model: E2E_MODEL,
		turnId: agentTurnId("turn-pending"),
	}),
	sessionId: seeded.sessionId,
});

const chatRequests = () =>
	recorder.requests.filter((request) => request.kind === "chat");

test("shows the opening state, then the session it opened", async () => {
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			pricing: createE2ePricing(200_000),
			sessionId: seeded.sessionId,
		});
		setup = rendered.setup;
		// The Agent Session does not exist until opening completes, so the surface
		// shows a session opening rather than a blank frame.
		await setup.renderOnce();
		expect(setup.captureCharFrame()).toContain("Loading session...");

		await rendered.registryReady;
		await settleSessionUi(setup);
		await act(async () => {
			await setup?.waitForFrame((frame) => frame.includes("start this turn"), {
				maxPasses: 200,
			});
		});
		writeE2EFrame(setup);
	} finally {
		cleanupSessionRender();
		setup?.renderer.destroy();
	}
});

test("shows the failure when the session cannot open", async () => {
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			pricing: createE2ePricing(200_000),
			sessionId: sessionId("session-that-does-not-exist"),
		});
		setup = rendered.setup;
		await rendered.registryReady;
		await act(async () => {
			await setup?.waitForFrame(
				(frame) => frame.includes("Session not found"),
				{ maxPasses: 200 }
			);
		});
		writeE2EFrame(setup);
	} finally {
		cleanupSessionRender();
		setup?.renderer.destroy();
	}
});

test("starts the first turn from navigation state exactly once", async () => {
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			initialSubmission: { messageId: pendingMessage.id },
			pricing: createE2ePricing(200_000),
			sessionId: seeded.sessionId,
		});
		setup = rendered.setup;
		await rendered.registryReady;

		await waitForSessionFrame(setup, (frame) =>
			frame.includes("E2E chat response")
		);
		expect(chatRequests()).toHaveLength(1);
		expect(chatRequests()[0]?.messages.at(-1)?.text).toContain(
			"start this turn"
		);
		writeE2EFrame(setup);
	} finally {
		cleanupSessionRender();
		setup?.renderer.destroy();
	}
});
