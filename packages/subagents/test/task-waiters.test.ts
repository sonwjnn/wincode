import { expect, test } from "bun:test";
import {
	createSubagentTaskWaiters,
	type SubagentTaskReference,
} from "../src/index";

test("a registered task completion releases its waiter exactly once", async () => {
	const taskWaiters = createSubagentTaskWaiters<string, string>();
	taskWaiters.registerTask("task-1");
	taskWaiters.registerTask("task-1");
	const waiting = taskWaiters.waitForTask("task-1");

	taskWaiters.finishTask("task-1");
	taskWaiters.finishTask("task-1");

	await expect(waiting).resolves.toBeUndefined();
	expect(taskWaiters.activeTaskIds()).toEqual([]);
});

test("descendant traversal includes each durable task once", async () => {
	const taskWaiters = createSubagentTaskWaiters<string, string>();
	type Task = SubagentTaskReference<string, string> & {
		status: "active" | "awaiting_report" | "succeeded";
	};
	const parentTask: Task = {
		childSessionId: "child",
		id: "parent-task",
		parentSessionId: "parent",
		status: "awaiting_report",
	};
	const childTask: Task = {
		childSessionId: "grandchild",
		id: "child-task",
		parentSessionId: "child",
		status: "succeeded",
	};
	const tasksByParent = new Map<string, readonly Task[]>([
		["parent", [parentTask]],
		["child", [childTask]],
		["grandchild", []],
	]);

	const result = await taskWaiters.waitForDescendants<Task>({
		isActive: (task) => task.status === "active",
		listTasks: async (sessionId) => tasksByParent.get(sessionId) ?? [],
		parentSessionId: "parent",
	});

	expect(result.map(({ id }) => id)).toEqual(["parent-task", "child-task"]);
});

test("an active durable task without a live runtime is an explicit error", async () => {
	const taskWaiters = createSubagentTaskWaiters<string, string>();
	type Task = SubagentTaskReference<string, string> & {
		status: "active";
	};
	const task: Task = {
		childSessionId: "child",
		id: "task-1",
		parentSessionId: "parent",
		status: "active",
	};

	await expect(
		taskWaiters.waitForDescendants<Task>({
			isActive: (entry) => entry.status === "active",
			listTasks: async () => [task],
			parentSessionId: "parent",
		})
	).rejects.toThrow("Active Delegation Task task-1 has no live runtime.");
});
