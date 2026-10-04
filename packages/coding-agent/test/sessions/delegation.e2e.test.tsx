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
import { getInteractiveSessionHostManager } from "@/modules/sessions/host/session-host-manager";
import type { SessionId } from "@/shared/identifiers";
import {
	createFakeModelClientModule,
	createFakeModelClientRecorder,
} from "@/test/support/e2e-fake-runtime";
import { toolCallId } from "../support/identifiers";

const previousEnvironment = {
	WINCODE_E2E_HOME: process.env.WINCODE_E2E_HOME,
	WINCODE_E2E_WORKSPACE: process.env.WINCODE_E2E_WORKSPACE,
	WINCODE_LOCAL_DB_PATH: process.env.WINCODE_LOCAL_DB_PATH,
	WINCODE_MODEL_PRICING_OFFLINE: process.env.WINCODE_MODEL_PRICING_OFFLINE,
};
const testDirectory = await mkdtemp(join(tmpdir(), "wincode-delegation-e2e-"));
process.env.WINCODE_LOCAL_DB_PATH = join(testDirectory, "conversation.sqlite");
process.env.WINCODE_E2E_HOME = testDirectory;
process.env.WINCODE_E2E_WORKSPACE = testDirectory;
process.env.WINCODE_MODEL_PRICING_OFFLINE = "true";

const restoreEnvironment = (): void => {
	for (const [key, value] of Object.entries(previousEnvironment)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
};

const recorder = createFakeModelClientRecorder();
await mock.module("@wincode/ai/model-client", () =>
	createFakeModelClientModule(recorder)
);
const {
	cleanupSessionRender,
	createE2ePricing,
	createE2eStore,
	renderSession,
	seedCompactionHistory,
	waitForSessionCondition,
	waitForSessionFrame,
	settleSessionUi,
	writeE2EFrame,
} = await import("@/test/support/e2e-fixture");

afterAll(async () => {
	mock.restore();
	restoreEnvironment();
	await rm(testDirectory, { force: true, recursive: true });
});

const CHILD_PROMPT = "Inspect the repository state.";
const CHILD_OUTPUT = "Child investigation stays in its own Session.";
const PARENT_OUTPUT = "Parent received a child Task ID.";
const configDocument = `{
	"agents": {
		"scout": { "description": "Inspect and report findings", "role": "subagent" }
	}
}`;
const approvalConfigDocument = `{
	"agents": {
		"build": { "permission": { "read": "ask" } },
		"scout": {
			"description": "Inspect and report findings",
			"permission": { "read": "ask" },
			"role": "subagent"
		}
	}
}`;

test("projects delegated work as a separate durable Session, not parent transcript output", async () => {
	const store = createE2eStore();
	const { sessionId: parentSessionId } = await seedCompactionHistory(store, 1);
	const priorStepScript = recorder.stepScript;
	const callId = toolCallId("separate-session-delegation");
	recorder.stepScript = async function* (
		request: ModelStepRequest
	): AsyncGenerator<ModelStreamPart> {
		const latestUserText =
			request.messages
				.filter(({ role }) => role === "user")
				.at(-1)
				?.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n") ?? "";
		if (latestUserText === CHILD_PROMPT) {
			yield { delta: CHILD_OUTPUT, type: "text-delta" };
			yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
			return;
		}
		if (request.messages.some(({ role }) => role === "tool")) {
			yield { delta: PARENT_OUTPUT, type: "text-delta" };
			yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
			return;
		}
		yield {
			input: { agent: "scout", prompt: CHILD_PROMPT },
			toolCallId: callId,
			toolName: "delegate",
			type: "tool-call",
		};
		yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
	};
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			configDocument,
			pricing: createE2ePricing(200_000),
			sessionId: parentSessionId,
		});
		setup = rendered.setup;
		await rendered.registryReady;
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("context detail")
		);
		await act(async () => {
			await setup?.flush();
			await setup?.flush();
		});
		await act(async () => {
			await setup?.mockInput.typeText("delegate the inspection");
			await setup?.flush();
			setup?.mockInput.pressEnter();
		});
		await waitForSessionCondition(async () =>
			(await store.listDelegationTasks(parentSessionId)).some(
				(task) =>
					task.parentToolCallId === callId && task.status === "awaiting_report"
			)
		);
		await waitForSessionFrame(setup, (frame) => frame.includes(PARENT_OUTPUT));
		await settleSessionUi(setup);
		const task = (await store.listDelegationTasks(parentSessionId)).find(
			(candidate) => candidate.parentToolCallId === callId
		);
		expect(task).toMatchObject({
			parentSessionId,
			status: "awaiting_report",
		});
		if (task === undefined) {
			throw new Error("The delegated task was not durably recorded.");
		}
		expect(task.childSessionId).not.toBe(parentSessionId);
		const parentFrame = setup.captureCharFrame();
		expect(parentFrame).toContain(PARENT_OUTPUT);
		expect(parentFrame).not.toContain(CHILD_OUTPUT);

		const childRecords = await store.listSessionRecords(task.childSessionId);
		const parentRecords = await store.listSessionRecords(parentSessionId);
		expect(
			childRecords.some(
				(record) =>
					record.outcome.kind === "assistant" &&
					record.messages.some((message) =>
						message.parts.some(
							(part) => part.type === "text" && part.text.includes(CHILD_OUTPUT)
						)
					)
			)
		).toBe(true);
		expect(
			parentRecords.some((record) =>
				record.messages.some((message) =>
					message.parts.some(
						(part) => part.type === "text" && part.text.includes(CHILD_OUTPUT)
					)
				)
			)
		).toBe(false);
	} finally {
		recorder.stepScript = priorStepScript;
		if (setup) {
			writeE2EFrame(setup);
			setup.renderer.destroy();
		}
		cleanupSessionRender();
	}
});
test("shows a minimal parent notice for a background child's pending approval", async () => {
	const store = createE2eStore();
	const { sessionId: parentSessionId } = await seedCompactionHistory(
		store,
		1,
		"background-approval"
	);
	const manager = getInteractiveSessionHostManager();
	const priorStepScript = recorder.stepScript;
	const callId = toolCallId("background-approval-delegation");
	const childReadCallId = toolCallId("background-child-read");
	const pendingApprovalNotice = Promise.withResolvers<{
		pendingApprovalCount: number;
		sessionId: SessionId;
	}>();
	const unsubscribeManager = manager.onEvent((event) => {
		if (
			event.type === "session-approval-notice" &&
			event.sessionId !== parentSessionId &&
			event.pendingApprovalCount > 0
		) {
			pendingApprovalNotice.resolve({
				pendingApprovalCount: event.pendingApprovalCount,
				sessionId: event.sessionId,
			});
		}
	});
	await Bun.write(join(testDirectory, "notes.txt"), "approval target");
	recorder.stepScript = async function* (
		request: ModelStepRequest
	): AsyncGenerator<ModelStreamPart> {
		const latestUserText =
			request.messages
				.filter(({ role }) => role === "user")
				.at(-1)
				?.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n") ?? "";
		if (latestUserText === CHILD_PROMPT) {
			yield {
				input: { path: join(testDirectory, "notes.txt") },
				toolCallId: childReadCallId,
				toolName: "read",
				type: "tool-call",
			};
			yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
			return;
		}
		if (request.messages.some(({ role }) => role === "tool")) {
			yield { delta: PARENT_OUTPUT, type: "text-delta" };
			yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
			return;
		}
		yield {
			input: { agent: "scout", prompt: CHILD_PROMPT },
			toolCallId: callId,
			toolName: "delegate",
			type: "tool-call",
		};
		yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
	};
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			configDocument: approvalConfigDocument,
			pricing: createE2ePricing(200_000),
			sessionId: parentSessionId,
		});
		setup = rendered.setup;
		await rendered.registryReady;
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("context detail")
		);
		await act(async () => {
			await setup?.flush();
			await setup?.flush();
		});
		await act(async () => {
			await setup?.mockInput.typeText("delegate the protected read");
			await setup?.flush();
			setup?.mockInput.pressEnter();
		});
		const notice = await pendingApprovalNotice.promise;
		expect(notice.pendingApprovalCount).toBe(1);
		const task = (await store.listDelegationTasks(parentSessionId)).find(
			(candidate) => candidate.parentToolCallId === callId
		);
		if (task === undefined) {
			throw new Error("The approval task was not durably recorded.");
		}
		expect(task.status).toBe("active");
		expect(task.childSessionId).toBe(notice.sessionId);
		const surfaceSetup = setup;
		if (surfaceSetup === undefined) {
			throw new Error("The parent Session surface did not mount.");
		}
		await act(async () => {
			await surfaceSetup.flush();
			await surfaceSetup.flush();
		});
		await waitForSessionFrame(surfaceSetup, (frame) =>
			frame.includes(`Session ${task.childSessionId}`)
		);
		const frame = surfaceSetup.captureCharFrame();
		expect(frame).toContain(`Session ${task.childSessionId}`);
		expect(frame).toContain("pending approval");
		expect(frame).not.toContain(childReadCallId);
	} finally {
		recorder.stepScript = priorStepScript;
		if (setup) {
			writeE2EFrame(setup);
			setup.renderer.destroy();
		}
		cleanupSessionRender();
		await manager.shutdownAll();
		unsubscribeManager();
	}
});
