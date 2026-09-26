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
	SessionRecord,
	ToolCallId,
	ToolCallOutput,
} from "@wincode/agent-core";
import type {
	ModelStepRequest,
	ModelStreamPart,
} from "@wincode/ai/model-client";
import { act } from "react";
import { SessionInUseError } from "@/modules/sessions/storage/session-lease";
import type { FakeModelStepScript } from "@/test/support/e2e-fake-runtime";
import {
	createFakeModelClientModule,
	createFakeModelClientRecorder,
} from "@/test/support/e2e-fake-runtime";
import { toolCallId } from "../support/identifiers";

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

/** The Tool Call Identifiers of the turn a journey started. */
const callIdsForTurn = (prompt: string): readonly ToolCallId[] =>
	prompt.includes("again") ? [UNMOUNT_CALL, AFTER_UNMOUNT_CALL] : [READ_CALL];

/**
 * Each provider step asks for one gated read so the UI can settle its first
 * approval before the next model step requests another.
 */
const gatedOutcomes = new Map<ToolCallId, ToolCallOutput>();
const completedCallsByUserMessage = new Map<number, Set<ToolCallId>>();
const approvalScript: FakeModelStepScript = async function* (
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
	const userMessages = request.messages.filter(
		(message) => message.role === "user"
	);
	const turnKey = userMessages.length;
	const currentPrompt =
		userMessages
			.at(-1)
			?.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n") ?? "";
	const callIds = callIdsForTurn(currentPrompt);
	const completedCalls =
		completedCallsByUserMessage.get(turnKey) ?? new Set<ToolCallId>();
	completedCallsByUserMessage.set(turnKey, completedCalls);
	for (const message of request.messages) {
		for (const part of message.content) {
			if (part.type === "tool-result") {
				const callId = toolCallId(part.toolCallId);
				if (!callIds.includes(callId)) {
					continue;
				}
				completedCalls.add(callId);
				gatedOutcomes.set(callId, {
					output: part.output,
					type: "success",
				});
			} else if (part.type === "tool-failure") {
				const callId = toolCallId(part.toolCallId);
				if (!callIds.includes(callId)) {
					continue;
				}
				completedCalls.add(callId);
				gatedOutcomes.set(callId, {
					errorText: part.errorText,
					type: "failure",
				});
			}
		}
	}
	const nextCallId = callIds.find((callId) => !completedCalls.has(callId));
	if (nextCallId) {
		yield {
			input: { path: FILE_NAME },
			toolCallId: nextCallId,
			toolName: "read",
			type: "tool-call",
		};
		yield {
			type: "finish",
			usage: { inputTokens: 1, outputTokens: 1 },
		};
		return;
	}
	yield { delta: "Notes read.", type: "text-delta" };
	yield {
		type: "finish",
		usage: { inputTokens: 1, outputTokens: 1 },
	};
};

const recorder = createFakeModelClientRecorder();
await mock.module("@wincode/ai/model-client", () =>
	createFakeModelClientModule(recorder, approvalScript)
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
const { sessionId } = await seedCompactionHistory(store, 1);
await globalThis.Bun.write(join(testDirectory, FILE_NAME), FILE_CONTENT);

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

const renderApprovalJourney = async (): Promise<TestRendererSetup> => {
	const rendered = await renderSession({
		configDocument: CONFIG_DOCUMENT,
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
	const requestCountBefore = recorder.requests.filter(
		(request) => request.kind === "chat"
	).length;
	try {
		await submitPrompt(setup, "read the notes again");
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("Permission required")
		);

		// Session shutdown aborts the waiting Tool Gate evaluation. The Agent
		// Turn ends as cancelled without another Model Step or gated Tool Call.
		writeE2EFrame(setup);
		await act(async () => {
			setup.renderer.destroy();
		});
		await waitForSessionCondition(async () => {
			try {
				const lease = await store.acquireSessionLease(sessionId);
				lease.release();
				return true;
			} catch (error) {
				if (error instanceof SessionInUseError) {
					return false;
				}
				throw error;
			}
		});
		const records = await store.listSessionRecords(sessionId);
		expect(
			recorder.requests.filter((request) => request.kind === "chat")
		).toHaveLength(requestCountBefore + 1);
		expect(completedToolRecords(records, UNMOUNT_CALL)).toHaveLength(0);
		expect(completedToolRecords(records, AFTER_UNMOUNT_CALL)).toHaveLength(0);
	} finally {
		cleanupSessionRender();
	}
});
