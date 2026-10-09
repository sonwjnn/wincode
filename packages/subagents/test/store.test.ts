import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionSdkCapabilityCeiling } from "@wincode/coding-agent";
import { createSubagentsTaskStore } from "../src/plugin/store";
import { toDelegationTaskId } from "../src/plugin/task-types";
import { agentId, agentTurnId, sessionId, toolCallId } from "./identifiers";

const directory = await mkdtemp(
	path.join(os.tmpdir(), "wincode-subagents-store-")
);
const databasePath = path.join(directory, "nested", "subagents.sqlite");

afterAll(async () => {
	await rm(directory, { force: true, recursive: true });
});

test("Subagents persists capability ceilings with outcomes and acknowledgments", async () => {
	const store = await createSubagentsTaskStore(databasePath);
	const capabilityCeiling: SessionSdkCapabilityCeiling = { tools: ["read"] };
	const task = store.createTask({
		agentId: agentId("scout"),
		capabilityCeiling,
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
			capabilityCeiling,
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

test("an existing Subagents database gains ceiling storage without losing active tasks", async () => {
	const legacyPath = path.join(directory, "legacy-subagents.sqlite");
	const legacyDatabase = new Database(legacyPath, { create: true });
	legacyDatabase.exec(`
		CREATE TABLE subagents_task (
			id TEXT PRIMARY KEY NOT NULL,
			agent_id TEXT NOT NULL,
			child_session_id TEXT NOT NULL UNIQUE,
			parent_session_id TEXT NOT NULL,
			parent_tool_call_id TEXT NOT NULL,
			parent_turn_id TEXT NOT NULL,
			status TEXT NOT NULL,
			outcome_json TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			report_consumed_at INTEGER
		);
		INSERT INTO subagents_task VALUES (
			'legacy-task', 'scout', 'legacy-child', 'legacy-parent',
			'legacy-call', 'legacy-turn', 'active', NULL, 1000, 1000, NULL
		);
	`);
	legacyDatabase.close();

	const store = await createSubagentsTaskStore(legacyPath);
	try {
		expect(store.getTask(toDelegationTaskId("legacy-task"))).toMatchObject({
			childSessionId: sessionId("legacy-child"),
			status: "active",
		});
		const capabilityCeiling: SessionSdkCapabilityCeiling = {
			tools: ["read", "grep"],
		};
		const created = store.createTask({
			agentId: agentId("scout"),
			capabilityCeiling,
			childSessionId: sessionId("new-child"),
			parentSessionId: sessionId("new-parent"),
			parentToolCallId: toolCallId("new-call"),
			parentTurnId: agentTurnId("new-turn"),
		});
		expect(store.getTask(created.id)?.capabilityCeiling).toEqual(
			capabilityCeiling
		);
	} finally {
		store.close();
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
