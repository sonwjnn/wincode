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
import { link, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestRendererSetup } from "@opentui/core/testing";
import {
	createOperationalFailure,
	type SessionRecord,
} from "@wincode/agent-core";
import { act } from "react";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import { getSessionStore } from "@/modules/sessions/storage/get-session-store";
import {
	resolveLocalAttachmentRoot,
	resolveLocalSnapshotRoot,
} from "@/modules/sessions/storage/path";
import {
	SessionInUseError,
	SessionWriterLockFailureError,
} from "@/modules/sessions/storage/session-writer-lock";
import type { SessionId } from "@/shared/identifiers";
import { setInteractiveRuntimeContext } from "@/shared/runtime-context";
import {
	createFakeModelClientModule,
	createFakeModelClientRecorder,
} from "@/test/support/e2e-fake-runtime";
import {
	agentId,
	agentTurnId,
	sessionMessageId,
	sessionRecordId,
} from "../support/identifiers";
import { startSessionWriterContender } from "../support/session-writer-process";

const testDirectory = await mkdtemp(
	join(tmpdir(), "wincode-session-opening-e2e-")
);
const databasePath = join(testDirectory, "conversation.sqlite");
process.env.WINCODE_LOCAL_DB_PATH = databasePath;
process.env.WINCODE_E2E_HOME = testDirectory;
process.env.WINCODE_E2E_WORKSPACE = testDirectory;
setInteractiveRuntimeContext({ args: [], cwd: testDirectory });
const aliasDatabasePath = join(
	testDirectory,
	"conversation-owner-alias.sqlite"
);
// Create the hard link before SQLite opens the database.
await Bun.write(databasePath, "");
await link(databasePath, aliasDatabasePath);
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
const activateSessionWriterAction = async (
	setup: TestRendererSetup,
	id: string
): Promise<void> => {
	const action = setup.renderer.root.findDescendantById(id);
	expect(action?.focusable).toBe(true);
	await act(() => {
		action?.focus();
		setup.mockInput.pressEnter();
	});
};
const startWriterContender = async (
	id: string,
	contenderDatabasePath = databasePath
) => {
	const contender = startSessionWriterContender({
		attachmentRoot: resolveLocalAttachmentRoot(contenderDatabasePath),
		databasePath: contenderDatabasePath,
		sessionId: id,
		snapshotRoot: resolveLocalSnapshotRoot(contenderDatabasePath),
		workspaceRoot: testDirectory,
	});
	const result = await contender.result;
	if (result.kind !== "acquired") {
		await contender.stop();
		throw new Error("The writer contender did not acquire the session.");
	}
	return contender;
};
const commitHistoryUserMessage = async (
	destinationSessionId: SessionId,
	id: string,
	text: string,
	destinationStore = store
): Promise<void> => {
	const message = {
		id: sessionMessageId(`history-${id}`),
		parts: [{ text, type: "text" as const }],
		role: "user" as const,
	};
	await destinationStore.commitSessionRecord({
		record: buildUserSessionRecord({
			agentId: agentId("build"),
			message,
			model: E2E_MODEL,
			turnId: agentTurnId(`history-${id}`),
		}),
		sessionId: destinationSessionId,
	});
};
const commitInterruptedHistoryRecord = async (
	destinationSessionId: SessionId
): Promise<void> => {
	const text = "The request ended safely.";
	const record: SessionRecord = {
		agentId: agentId("build"),
		id: sessionRecordId("record-interrupted-history"),
		messages: [
			{
				id: sessionMessageId("assistant-interrupted-history"),
				parts: [{ text, type: "text" }],
				role: "assistant",
			},
		],
		model: {
			modelId: E2E_MODEL.modelId,
			providerId: E2E_MODEL.providerId,
		},
		outcome: {
			kind: "assistant",
			terminal: {
				failure: createOperationalFailure({
					code: "interrupted",
					retry: "immediate",
					source: "runtime",
				}),
				finishedAt: 1,
				kind: "interrupted",
				reason: "user",
			},
		},
		turnId: agentTurnId("turn-interrupted-history"),
		version: 1,
	};
	await store.commitSessionRecord({
		record,
		sessionId: destinationSessionId,
	});
};

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
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("start this turn")
		);
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
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("Session not found")
		);
		expect(setup.captureCharFrame()).not.toContain("Stored Session History");
		expect(setup.captureCharFrame()).not.toContain("Refresh history");
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

test("offers read-only history during process contention and retries with fresh state", async () => {
	const historySession = await seedCompactionHistory(
		store,
		1,
		"writer-history"
	);
	let contender = await startWriterContender(historySession.sessionId);
	const initialOwnerPid = contender.pid;
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			pricing: createE2ePricing(200_000),
			sessionId: historySession.sessionId,
		});
		setup = rendered.setup;
		await rendered.registryReady;
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("View Stored Session History")
		);
		const contentionFrame = setup.captureCharFrame();
		expect(contentionFrame).toContain(`PID ${contender.pid}`);
		expect(contentionFrame).toContain("Unverified lock owner");
		expect(contentionFrame).not.toContain("Stored Session History · Read-only");
		expect(contentionFrame).not.toContain("retained-turn-1");

		await activateSessionWriterAction(setup, "session-contention-view-history");
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("Stored Session History · Read-only")
		);

		const initialFrame = setup.captureCharFrame();
		expect(initialFrame).toContain(`PID ${contender.pid}`);
		expect(initialFrame).toContain("Unverified lock owner");
		expect(initialFrame).toContain("mode interactive");
		expect(initialFrame).toContain("retained-turn-1");
		expect(initialFrame).toContain("Refresh history");
		expect(initialFrame).toContain("Retry / Open for editing");
		expect(initialFrame).not.toContain("Ask anything...");
		expect(initialFrame).not.toContain("Rename Session");
		expect(initialFrame).not.toContain("Approve");
		expect(initialFrame).not.toContain("Interrupt");
		expect(initialFrame).not.toContain("Compact");

		const refreshedMessage = "visible only after manual history refresh";
		await commitHistoryUserMessage(
			historySession.sessionId,
			"refresh-record",
			refreshedMessage
		);
		await settleSessionUi(setup);
		expect(setup.captureCharFrame()).not.toContain(refreshedMessage);

		await activateSessionWriterAction(setup, "stored-session-history-refresh");
		await waitForSessionFrame(setup, (frame) =>
			frame.includes(refreshedMessage)
		);

		await contender.release();
		contender = await startWriterContender(historySession.sessionId);
		expect(contender.pid).not.toBe(initialOwnerPid);
		await activateSessionWriterAction(setup, "stored-session-history-open");
		await waitForSessionFrame(setup, (frame) =>
			frame.includes(`PID ${contender.pid}`)
		);
		const retryConflictFrame = setup.captureCharFrame();
		expect(retryConflictFrame).toContain("Stored Session History");
		expect(retryConflictFrame).toContain("Unverified lock owner");
		expect(retryConflictFrame).not.toContain("Ask anything...");

		const freshHostMessage = "loaded by the newly opened writable host";
		await commitHistoryUserMessage(
			historySession.sessionId,
			"fresh-host-record",
			freshHostMessage
		);
		await contender.release();
		await activateSessionWriterAction(setup, "stored-session-history-open");
		await waitForSessionFrame(
			setup,
			(frame) =>
				frame.includes(freshHostMessage) && frame.includes("Ask anything...")
		);
		expect(setup.captureCharFrame()).not.toContain("Stored Session History");
	} finally {
		await contender.release();
		cleanupSessionRender();
		setup?.renderer.destroy();
	}
}, 15_000);
test("stored history labels durable interrupted turns", async () => {
	const historySession = await seedCompactionHistory(
		store,
		1,
		"interrupted-history"
	);
	await commitInterruptedHistoryRecord(historySession.sessionId);
	const contender = await startWriterContender(historySession.sessionId);
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			pricing: createE2ePricing(200_000),
			sessionId: historySession.sessionId,
		});
		setup = rendered.setup;
		await rendered.registryReady;
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("View Stored Session History")
		);
		await activateSessionWriterAction(setup, "session-contention-view-history");
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("Build · GPT-5.6 Luna · interrupted")
		);
		const frame = setup.captureCharFrame();
		expect(frame).toContain("The request ended safely.");
		expect(frame).toContain("Build · GPT-5.6 Luna · interrupted");
		expect(frame).not.toContain("Ask anything...");
	} finally {
		await contender.release();
		cleanupSessionRender();
		setup?.renderer.destroy();
	}
}, 15_000);

test("closing stored history leaves the other process writer lock held", async () => {
	const historySession = await seedCompactionHistory(
		store,
		1,
		"closed-history"
	);
	const contender = await startWriterContender(historySession.sessionId);
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			pricing: createE2ePricing(200_000),
			sessionId: historySession.sessionId,
		});
		setup = rendered.setup;
		await rendered.registryReady;
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("View Stored Session History")
		);
		await activateSessionWriterAction(setup, "session-contention-view-history");
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("Stored Session History · Read-only")
		);

		await act(async () => {
			setup?.renderer.destroy();
		});
		setup = undefined;
		const conflict = await store
			.acquireSessionWriter(historySession.sessionId, {
				executionMode: "interactive",
			})
			.then(
				() => undefined,
				(error: unknown) => error
			);
		expect(conflict).toBeInstanceOf(SessionInUseError);
	} finally {
		cleanupSessionRender();
		setup?.renderer.destroy();
		await contender.release();
	}
});

test("does not offer history when acquiring the OS writer lock fails", async () => {
	const appStore = getSessionStore();
	const acquireSessionWriter = appStore.acquireSessionWriter;
	appStore.acquireSessionWriter = async () => {
		throw new SessionWriterLockFailureError(new Error("lock setup failed"));
	};
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			pricing: createE2ePricing(200_000),
			sessionId: seeded.sessionId,
		});
		setup = rendered.setup;
		await rendered.registryReady;
		await waitForSessionFrame(
			setup,
			(frame) => !frame.includes("Loading session...")
		);
		const frame = setup.captureCharFrame();
		expect(frame).not.toContain("Stored Session History");
		expect(frame).not.toContain("Refresh history");
		expect(frame).not.toContain("Retry / Open for editing");
	} finally {
		appStore.acquireSessionWriter = acquireSessionWriter;
		cleanupSessionRender();
		setup?.renderer.destroy();
	}
});
test("shows committed WAL history when the writer owns a hard-linked database path", async () => {
	const historySession = await seedCompactionHistory(
		store,
		1,
		"hard-link-history"
	);
	const aliasDatabase = createDatabase(aliasDatabasePath);
	try {
		const aliasStore = createDrizzleSessionStore(aliasDatabase.db, {
			attachmentRoot: resolveLocalAttachmentRoot(aliasDatabasePath),
			snapshotRoot: resolveLocalSnapshotRoot(aliasDatabasePath),
			workspaceRoot: process.cwd(),
		});
		const contender = await startWriterContender(
			historySession.sessionId,
			aliasDatabasePath
		);
		let setup: TestRendererSetup | undefined;
		try {
			const committedMessage = "committed through the owner's WAL alias";
			await commitHistoryUserMessage(
				historySession.sessionId,
				"hard-link-owner",
				committedMessage,
				aliasStore
			);
			const rendered = await renderSession({
				pricing: createE2ePricing(200_000),
				sessionId: historySession.sessionId,
			});
			setup = rendered.setup;
			await rendered.registryReady;
			await waitForSessionFrame(setup, (frame) =>
				frame.includes("View Stored Session History")
			);
			await activateSessionWriterAction(
				setup,
				"session-contention-view-history"
			);
			await waitForSessionFrame(
				setup,
				(frame) =>
					frame.includes("Stored Session History · Read-only") &&
					frame.includes(committedMessage)
			);
		} finally {
			await contender.release();
			cleanupSessionRender();
			setup?.renderer.destroy();
		}
	} finally {
		aliasDatabase.sqlite.close();
	}
}, 15_000);
