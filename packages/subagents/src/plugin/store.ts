import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentId, AgentTurnId, ToolCallId } from "@wincode/agent-core";
import { randomUUIDv7 } from "bun";
import {
	type DelegationReportEnvelope,
	type DelegationTask,
	type DelegationTaskId,
	type DelegationTaskOutcome,
	type DelegationTaskStatus,
	delegationTaskOutcomeSchema,
	delegationTaskStatusSchema,
	type SessionId,
	toDelegationTaskId,
	toSessionId,
} from "./task-types";

const SUBAGENTS_DATABASE_FILE = "subagents.sqlite";
const sharedStores = new Map<string, Promise<SubagentsTaskStore>>();
const sharedStoreLeaseCounts = new Map<string, number>();

export const resolveSubagentsDatabasePath = (
	workspace: string,
	userDataDir: string
): string => {
	const configuredPath = process.env.WINCODE_SUBAGENTS_DB_PATH;
	if (configuredPath !== undefined && configuredPath !== "") {
		return path.resolve(configuredPath);
	}
	const workspaceKey = new Bun.CryptoHasher("sha256")
		.update(path.resolve(workspace))
		.digest("hex")
		.slice(0, 24);
	return path.join(
		userDataDir,
		"subagents",
		workspaceKey,
		SUBAGENTS_DATABASE_FILE
	);
};
const statusForOutcome = (
	outcome: DelegationTaskOutcome
): DelegationTaskStatus => {
	switch (outcome.kind) {
		case "result":
			return "succeeded";
		case "failure":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "interrupted":
			return "interrupted";
		default:
			throw new Error("Unknown Subagents task outcome.");
	}
};

type TaskRow = Readonly<{
	id: string;
	agent_id: string;
	child_session_id: string;
	parent_session_id: string;
	parent_tool_call_id: string;
	parent_turn_id: string;
	status: string;
	outcome_json: string | null;
	created_at: number;
	updated_at: number;
	report_consumed_at: number | null;
}>;

const taskFromRow = (row: TaskRow): DelegationTask => ({
	agentId: row.agent_id as AgentId,
	childSessionId: toSessionId(row.child_session_id),
	createdAt: new Date(row.created_at),
	id: toDelegationTaskId(row.id),
	outcome:
		row.outcome_json === null
			? null
			: delegationTaskOutcomeSchema.parse(JSON.parse(row.outcome_json)),
	parentSessionId: toSessionId(row.parent_session_id),
	parentToolCallId: row.parent_tool_call_id as ToolCallId,
	parentTurnId: row.parent_turn_id as AgentTurnId,
	status: delegationTaskStatusSchema.parse(row.status),
	updatedAt: new Date(row.updated_at),
});

export type CreateSubagentsTaskInput = Readonly<{
	id?: DelegationTaskId;
	agentId: AgentId;
	childSessionId: SessionId;
	parentSessionId: SessionId;
	parentToolCallId: ToolCallId;
	parentTurnId: AgentTurnId;
}>;

export type SubagentsTaskStoreOptions = Readonly<{
	now?: () => number;
}>;

export type SubagentsTaskStore = Readonly<{
	close: () => void;
	createTask: (input: CreateSubagentsTaskInput) => DelegationTask;
	getTask: (taskId: DelegationTaskId) => DelegationTask | null;
	getTaskForChild: (childSessionId: SessionId) => DelegationTask | null;
	listTasks: (parentSessionId: SessionId) => DelegationTask[];
	listUnsettledTasks: () => DelegationTask[];
	listPendingReports: (
		parentSessionId: SessionId
	) => DelegationReportEnvelope[];
	markAwaitingReport: (taskId: DelegationTaskId) => boolean;
	consumeReport: (taskId: DelegationTaskId) => boolean;
	settleTask: (input: {
		outcome: DelegationTaskOutcome;
		taskId: DelegationTaskId;
	}) => DelegationReportEnvelope | null;
}>;

/** Opens Subagents' independent durable task/report database. */
export const createSubagentsTaskStore = async (
	databasePath: string,
	{ now = Date.now }: SubagentsTaskStoreOptions = {}
): Promise<SubagentsTaskStore> => {
	if (databasePath !== ":memory:") {
		await fs.mkdir(path.dirname(databasePath), { recursive: true });
	}
	const database = new Database(databasePath, { create: true });
	let databaseClosed = false;
	try {
		database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
		database.exec(`
			CREATE TABLE IF NOT EXISTS subagents_task (
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
			CREATE INDEX IF NOT EXISTS idx_subagents_task_parent_status
				ON subagents_task (parent_session_id, status, created_at, id);
			CREATE INDEX IF NOT EXISTS idx_subagents_task_child_status
				ON subagents_task (child_session_id, status);
			CREATE TABLE IF NOT EXISTS subagents_report_order (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				task_id TEXT NOT NULL UNIQUE
			);
			INSERT OR IGNORE INTO subagents_report_order (task_id)
				SELECT id FROM subagents_task
				WHERE outcome_json IS NOT NULL AND report_consumed_at IS NULL
				ORDER BY updated_at, id;
		`);
	} catch (error) {
		database.close();
		throw error;
	}

	const selectTask = database.query(
		"SELECT * FROM subagents_task WHERE id = ?"
	);
	const selectTaskForChild = database.query(
		"SELECT * FROM subagents_task WHERE child_session_id = ?"
	);
	const selectTasksForParent = database.query(
		"SELECT * FROM subagents_task WHERE parent_session_id = ? ORDER BY created_at, id"
	);
	const selectUnsettledTasks = database.query(
		"SELECT * FROM subagents_task WHERE status IN ('active', 'awaiting_report') ORDER BY created_at, id"
	);
	const selectPendingReports = database.query(
		`SELECT task.* FROM subagents_task AS task
		 INNER JOIN subagents_report_order AS report_order
			ON report_order.task_id = task.id
		 WHERE task.parent_session_id = ? AND task.outcome_json IS NOT NULL
			AND task.report_consumed_at IS NULL
		 ORDER BY report_order.sequence`
	);
	const createTask: SubagentsTaskStore["createTask"] = (input) => {
		const timestamp = now();
		const task: DelegationTask = {
			...input,
			createdAt: new Date(timestamp),
			id: input.id ?? toDelegationTaskId(randomUUIDv7()),
			outcome: null,
			status: "active",
			updatedAt: new Date(timestamp),
		};
		database
			.query(
				`INSERT INTO subagents_task (
					id, agent_id, child_session_id, parent_session_id,
					parent_tool_call_id, parent_turn_id, status, outcome_json,
					created_at, updated_at, report_consumed_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`
			)
			.run(
				task.id,
				task.agentId,
				task.childSessionId,
				task.parentSessionId,
				task.parentToolCallId,
				task.parentTurnId,
				task.status,
				timestamp,
				timestamp
			);
		return task;
	};
	const getTask: SubagentsTaskStore["getTask"] = (taskId) => {
		const row = selectTask.get(taskId) as TaskRow | null;
		return row === null ? null : taskFromRow(row);
	};
	const getTaskForChild: SubagentsTaskStore["getTaskForChild"] = (
		childSessionId
	) => {
		const row = selectTaskForChild.get(childSessionId) as TaskRow | null;
		return row === null ? null : taskFromRow(row);
	};
	const listTasks: SubagentsTaskStore["listTasks"] = (parentSessionId) =>
		(selectTasksForParent.all(parentSessionId) as TaskRow[]).map(taskFromRow);
	const listUnsettledTasks: SubagentsTaskStore["listUnsettledTasks"] = () =>
		(selectUnsettledTasks.all() as TaskRow[]).map(taskFromRow);
	const listPendingReports: SubagentsTaskStore["listPendingReports"] = (
		parentSessionId
	) =>
		(selectPendingReports.all(parentSessionId) as TaskRow[]).map((row) => {
			const task = taskFromRow(row);
			if (task.outcome === null) {
				throw new Error("A pending Subagents report has no outcome.");
			}
			return {
				childSessionId: task.childSessionId,
				createdAt: task.updatedAt,
				outcome: task.outcome,
				parentSessionId: task.parentSessionId,
				parentToolCallId: task.parentToolCallId,
				parentTurnId: task.parentTurnId,
				taskId: task.id,
			};
		});
	const markAwaitingReport: SubagentsTaskStore["markAwaitingReport"] = (
		taskId
	) =>
		database
			.query(
				"UPDATE subagents_task SET status = 'awaiting_report', updated_at = ? WHERE id = ? AND status = 'active' AND outcome_json IS NULL"
			)
			.run(now(), taskId).changes > 0;
	const consumeReport: SubagentsTaskStore["consumeReport"] = (taskId) =>
		database
			.query(
				"UPDATE subagents_task SET report_consumed_at = ? WHERE id = ? AND outcome_json IS NOT NULL AND report_consumed_at IS NULL"
			)
			.run(now(), taskId).changes > 0;
	const settleTask: SubagentsTaskStore["settleTask"] = ({
		outcome: rawOutcome,
		taskId,
	}) => {
		const outcome = delegationTaskOutcomeSchema.parse(rawOutcome);
		const timestamp = now();
		return database
			.transaction(() => {
				const updated = database
					.query(
						`UPDATE subagents_task
						SET outcome_json = ?, status = ?, updated_at = ?
						WHERE id = ? AND outcome_json IS NULL
							AND status IN ('active', 'awaiting_report', 'interrupted')`
					)
					.run(
						JSON.stringify(outcome),
						statusForOutcome(outcome),
						timestamp,
						taskId
					);
				if (updated.changes === 0) {
					return null;
				}
				database
					.query("INSERT INTO subagents_report_order (task_id) VALUES (?)")
					.run(taskId);
				const task = getTask(taskId);
				if (task === null) {
					return null;
				}
				return {
					childSessionId: task.childSessionId,
					createdAt: task.updatedAt,
					outcome,
					parentSessionId: task.parentSessionId,
					parentToolCallId: task.parentToolCallId,
					parentTurnId: task.parentTurnId,
					taskId: task.id,
				};
			})
			.immediate();
	};

	return Object.freeze({
		close: () => {
			if (databaseClosed) {
				return;
			}
			databaseClosed = true;
			database.close();
		},
		createTask,
		getTask,
		getTaskForChild,
		listTasks,
		listUnsettledTasks,
		listPendingReports,
		markAwaitingReport,
		consumeReport,
		settleTask,
	});
};

const sharedStoreKey = (databasePath: string): string =>
	databasePath === ":memory:" ? databasePath : path.resolve(databasePath);

export const getSharedSubagentsTaskStore = (
	databasePath: string
): Promise<SubagentsTaskStore> => {
	const key = sharedStoreKey(databasePath);
	let store = sharedStores.get(key);
	if (store === undefined) {
		let sharedStore: Promise<SubagentsTaskStore>;
		sharedStore = createSubagentsTaskStore(key).then((taskStore) =>
			Object.freeze({
				...taskStore,
				close: () => {
					if (sharedStores.get(key) === sharedStore) {
						sharedStores.delete(key);
					}
					taskStore.close();
				},
			})
		);
		store = sharedStore;
		sharedStores.set(key, store);
		void store.catch(() => {
			if (sharedStores.get(key) === store) {
				sharedStores.delete(key);
			}
		});
	}
	return store;
};

export type SubagentsTaskStoreLease = Readonly<{
	release: () => void;
	store: SubagentsTaskStore;
}>;

/** Acquires a shared database handle for one Plugin Runtime lifetime. */
export const acquireSharedSubagentsTaskStore = async (
	databasePath: string
): Promise<SubagentsTaskStoreLease> => {
	const key = sharedStoreKey(databasePath);
	const store = await getSharedSubagentsTaskStore(key);
	sharedStoreLeaseCounts.set(key, (sharedStoreLeaseCounts.get(key) ?? 0) + 1);
	let released = false;
	return Object.freeze({
		release: () => {
			if (released) {
				return;
			}
			released = true;
			const leaseCount = (sharedStoreLeaseCounts.get(key) ?? 1) - 1;
			if (leaseCount > 0) {
				sharedStoreLeaseCounts.set(key, leaseCount);
				return;
			}
			sharedStoreLeaseCounts.delete(key);
			store.close();
		},
		store,
	});
};
