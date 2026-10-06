export type SubagentTaskReference<
	SessionId extends string = string,
	TaskId extends string = string,
> = Readonly<{
	childSessionId: SessionId;
	id: TaskId;
	parentSessionId: SessionId;
}>;

export type WaitForSubagentDescendantsOptions<
	TaskId extends string,
	SessionId extends string,
	Task extends SubagentTaskReference<SessionId, TaskId>,
> = Readonly<{
	isActive: (task: Task) => boolean;
	listTasks: (sessionId: SessionId) => Promise<readonly Task[]>;
	parentSessionId: SessionId;
}>;

type TaskWaiter = Readonly<{
	promise: Promise<void>;
	resolve: () => void;
}>;

export type SubagentTaskWaiters<
	TaskId extends string,
	SessionId extends string,
> = Readonly<{
	activeTaskIds: () => readonly TaskId[];
	finishTask: (taskId: TaskId) => void;
	registerTask: (taskId: TaskId) => void;
	waitForDescendants: <Task extends SubagentTaskReference<SessionId, TaskId>>(
		options: WaitForSubagentDescendantsOptions<TaskId, SessionId, Task>
	) => Promise<readonly Task[]>;
	waitForTask: (taskId: TaskId) => Promise<void>;
}>;

/**
 * Coordinates live task completion while the host remains the durable source
 * of task state and descendant relationships.
 */
export const createSubagentTaskWaiters = <
	TaskId extends string,
	SessionId extends string,
>(): SubagentTaskWaiters<TaskId, SessionId> => {
	const taskWaiters = new Map<TaskId, TaskWaiter>();
	const finishTask = (taskId: TaskId): void => {
		const waiter = taskWaiters.get(taskId);
		if (waiter === undefined) {
			return;
		}
		taskWaiters.delete(taskId);
		waiter.resolve();
	};
	const registerTask = (taskId: TaskId): void => {
		if (taskWaiters.has(taskId)) {
			return;
		}
		const completion = Promise.withResolvers<void>();
		taskWaiters.set(taskId, {
			promise: completion.promise,
			resolve: () => completion.resolve(),
		});
	};
	const waitForTask = (taskId: TaskId): Promise<void> => {
		const waiter = taskWaiters.get(taskId);
		if (waiter === undefined) {
			throw new Error(`Active Delegation Task ${taskId} has no live runtime.`);
		}
		return waiter.promise;
	};
	const waitForDescendants = async <
		Task extends SubagentTaskReference<SessionId, TaskId>,
	>({
		isActive,
		listTasks,
		parentSessionId,
	}: WaitForSubagentDescendantsOptions<TaskId, SessionId, Task>): Promise<
		readonly Task[]
	> => {
		while (true) {
			const pendingSessions = [parentSessionId];
			const visitedSessions = new Set<SessionId>();
			const tasks = new Map<TaskId, Task>();
			while (pendingSessions.length > 0) {
				const sessionId = pendingSessions.pop();
				if (sessionId === undefined || visitedSessions.has(sessionId)) {
					continue;
				}
				visitedSessions.add(sessionId);
				for (const task of await listTasks(sessionId)) {
					tasks.set(task.id, task);
					pendingSessions.push(task.childSessionId);
				}
			}
			const activeTasks = [...tasks.values()].filter(isActive);
			if (activeTasks.length === 0) {
				return [...tasks.values()];
			}
			await Promise.all(activeTasks.map((task) => waitForTask(task.id)));
		}
	};

	return Object.freeze({
		activeTaskIds: () => Object.freeze([...taskWaiters.keys()]),
		finishTask,
		registerTask,
		waitForDescendants,
		waitForTask,
	});
};
