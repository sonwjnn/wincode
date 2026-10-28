import { expect, test } from "bun:test";
import {
	createPluginRuntime,
	type LoadedPlugin,
} from "@/modules/plugins/runtime";

const compactionContext = {
	sessionId: "session-hooks",
	signal: new AbortController().signal,
	trigger: "manual",
	workspace: "/workspace",
} as const;

const plugin = (
	id: string,
	hooks: Pick<
		LoadedPlugin,
		| "onBeforeCompaction"
		| "onCompactionCompleted"
		| "onCompactionFailed"
		| "onSessionStart"
	>
): LoadedPlugin => ({
	commands: [],
	id,
	sourcePath: `/plugins/${id}.ts`,
	tools: [],
	workspace: "/workspace",
	...hooks,
});

test("the first Plugin cancel decision stops the chain", async () => {
	let laterHookRan = false;
	const runtime = createPluginRuntime(
		[
			plugin("blocking", {
				onBeforeCompaction: () => ({ cancel: "Compaction is paused." }),
			}),
			plugin("later", {
				onBeforeCompaction: () => {
					laterHookRan = true;
					return { summary: "later summary" };
				},
			}),
		],
		[]
	);

	expect(runtime.runBeforeCompactionHooks(compactionContext)).resolves.toEqual({
		cancel: "Compaction is paused.",
	});
	expect(laterHookRan).toBe(false);
});

test("a failing pre-compaction hook cannot block the next Plugin's decision", async () => {
	const runtime = createPluginRuntime(
		[
			plugin("broken", {
				onBeforeCompaction: () => {
					throw new Error("hook exploded");
				},
			}),
			plugin("custom", {
				onBeforeCompaction: async () => ({ summary: "custom handoff" }),
			}),
		],
		[]
	);

	expect(runtime.runBeforeCompactionHooks(compactionContext)).resolves.toEqual({
		summary: "custom handoff",
	});
});

test("empty decisions are ignored instead of cancelling or replacing a summary", async () => {
	const runtime = createPluginRuntime(
		[plugin("empty", { onBeforeCompaction: () => ({ cancel: "  " }) })],
		[]
	);

	await expect(
		runtime.runBeforeCompactionHooks(compactionContext)
	).resolves.toBeUndefined();
});

test("completed and failed notifications reach every Plugin even when one hook throws", async () => {
	const completed: string[] = [];
	const failed: string[] = [];
	const runtime = createPluginRuntime(
		[
			plugin("first", {
				onCompactionCompleted: () => {
					throw new Error("observer exploded");
				},
				onCompactionFailed: () => {
					throw new Error("observer exploded");
				},
			}),
			plugin("second", {
				onCompactionCompleted: (context) => {
					completed.push(`${context.compactionId}:${context.tokensBefore}`);
				},
				onCompactionFailed: (context) => {
					failed.push(context.error);
				},
			}),
		],
		[]
	);

	await runtime.notifyCompactionCompleted({
		...compactionContext,
		compactionId: "compaction:1",
		estimatedTokensAfter: 100,
		tokensBefore: 1000,
	});
	await runtime.notifyCompactionFailed({
		...compactionContext,
		error: "The store is unavailable.",
	});

	expect(completed).toEqual(["compaction:1:1000"]);
	expect(failed).toEqual(["The store is unavailable."]);
});

test("a Plugin disabled for the Session cannot decide or observe compaction", async () => {
	const calls: string[] = [];
	const runtime = createPluginRuntime(
		[
			plugin("disabled", {
				onSessionStart: () => {
					throw new Error("session start failed");
				},
				onBeforeCompaction: () => {
					calls.push("disabled-before");
					return { cancel: "must not cancel" };
				},
				onCompactionCompleted: () => {
					calls.push("disabled-completed");
				},
			}),
			plugin("active", {
				onBeforeCompaction: () => {
					calls.push("active-before");
					return { summary: "active handoff" };
				},
				onCompactionCompleted: () => {
					calls.push("active-completed");
				},
			}),
		],
		[]
	);
	await runtime.startSession({
		sessionId: "session-hooks",
		workspace: "/workspace",
	});

	expect(await runtime.runBeforeCompactionHooks(compactionContext)).toEqual({
		summary: "active handoff",
	});
	await runtime.notifyCompactionCompleted({
		...compactionContext,
		compactionId: "compaction:disabled",
		estimatedTokensAfter: 10,
		tokensBefore: 100,
	});
	expect(calls).toEqual(["active-before", "active-completed"]);
});
