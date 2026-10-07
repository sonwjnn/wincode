import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createSubagentsTaskStore } from "@/plugins/subagents/store";
import {
	agentId,
	agentTurnId,
	sessionId,
	toolCallId,
} from "../../support/identifiers";

const directory = await mkdtemp(
	path.join(os.tmpdir(), "wincode-subagents-store-")
);
const databasePath = path.join(directory, "subagents.sqlite");

afterAll(async () => {
	await rm(directory, { force: true, recursive: true });
});

test("Subagents task outcomes and report acknowledgments persist in its own database", async () => {
	const store = await createSubagentsTaskStore(databasePath);
	const task = store.createTask({
		agentId: agentId("scout"),
		childSessionId: sessionId("child-session"),
		parentSessionId: sessionId("parent-session"),
		parentToolCallId: toolCallId("parent-call"),
		parentTurnId: agentTurnId("parent-turn"),
	});
	const report = store.settleTask({
		outcome: { kind: "result", report: { summary: "Inspection complete." } },
		taskId: task.id,
	});
	if (report === null) {
		throw new Error("Expected the new Subagents Task to settle.");
	}

	expect(report).toMatchObject({
		outcome: { kind: "result", report: { summary: "Inspection complete." } },
		taskId: task.id,
	});
	expect(store.listPendingReports(task.parentSessionId)).toEqual([report]);
	store.close();

	const reopened = await createSubagentsTaskStore(databasePath);
	try {
		expect(reopened.getTask(task.id)).toMatchObject({
			id: task.id,
			outcome: { kind: "result", report: { summary: "Inspection complete." } },
			status: "succeeded",
		});
		expect(reopened.consumeReport(task.id)).toBe(true);
		expect(reopened.consumeReport(task.id)).toBe(false);
		expect(reopened.listPendingReports(task.parentSessionId)).toEqual([]);
	} finally {
		reopened.close();
	}
});

test("a later Subagents outcome cannot replace the first durable result", async () => {
	const store = await createSubagentsTaskStore(
		path.join(directory, "single-outcome.sqlite")
	);
	const task = store.createTask({
		agentId: agentId("scout"),
		childSessionId: sessionId("single-child"),
		parentSessionId: sessionId("single-parent"),
		parentToolCallId: toolCallId("single-call"),
		parentTurnId: agentTurnId("single-turn"),
	});
	try {
		const first = store.settleTask({
			outcome: { kind: "failure", reason: "First outcome." },
			taskId: task.id,
		});
		const second = store.settleTask({
			outcome: { kind: "result", report: { summary: "Must not replace." } },
			taskId: task.id,
		});

		expect(first?.outcome).toEqual({
			kind: "failure",
			reason: "First outcome.",
		});
		expect(second).toBeNull();
		expect(store.getTask(task.id)?.outcome).toEqual({
			kind: "failure",
			reason: "First outcome.",
		});
	} finally {
		store.close();
	}
});
