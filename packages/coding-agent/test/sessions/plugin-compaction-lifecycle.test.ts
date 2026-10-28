import { expect, test } from "bun:test";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import { createPluginCompactionLifecycle } from "@/modules/sessions/host/plugin-compaction-lifecycle";
import { agentTurnId, compactionId, sessionId } from "../support/identifiers";

const runtimeWith = (overrides: Partial<PluginRuntime>): PluginRuntime =>
	overrides as PluginRuntime;

test("the Host adapter forwards identity and trigger to the Plugin decision", async () => {
	const contexts: unknown[] = [];
	const lifecycle = createPluginCompactionLifecycle({
		getRuntime: () =>
			runtimeWith({
				runBeforeCompactionHooks: async (context) => {
					contexts.push(context);
					return { cancel: "  paused by policy  " };
				},
			}),
		workspace: "/workspace",
	});
	const signal = new AbortController().signal;

	const decision = await lifecycle.before?.({
		focus: "release notes",
		sessionId: sessionId("session-adapter"),
		signal,
		trigger: "manual",
		turnId: agentTurnId("turn-adapter"),
	});

	expect(contexts).toEqual([
		{
			focus: "release notes",
			sessionId: "session-adapter",
			signal,
			trigger: "manual",
			turnId: "turn-adapter",
			workspace: "/workspace",
		},
	]);
	expect(decision).toEqual({ cancel: "paused by policy" });
});

test("the Host adapter reports a committed compaction and its failure separately", async () => {
	const completed: unknown[] = [];
	const failed: unknown[] = [];
	const lifecycle = createPluginCompactionLifecycle({
		getRuntime: () =>
			runtimeWith({
				notifyCompactionCompleted: async (context) => {
					completed.push(context);
				},
				notifyCompactionFailed: async (context) => {
					failed.push(context);
				},
			}),
		workspace: "/workspace",
	});
	const context = {
		sessionId: sessionId("session-adapter"),
		trigger: "threshold",
	} as const;

	await lifecycle.completed?.(
		{
			estimatedTokensAfter: 20,
			id: compactionId("compaction-adapter"),
			tokensBefore: 200,
		} as never,
		context
	);
	await lifecycle.failed?.({
		...context,
		error: new Error("No summary model."),
	});

	expect(completed).toEqual([
		expect.objectContaining({
			compactionId: "compaction-adapter",
			estimatedTokensAfter: 20,
			sessionId: "session-adapter",
			tokensBefore: 200,
			trigger: "threshold",
			workspace: "/workspace",
		}),
	]);
	expect(failed).toEqual([
		expect.objectContaining({
			error: "No summary model.",
			sessionId: "session-adapter",
			trigger: "threshold",
		}),
	]);
});
