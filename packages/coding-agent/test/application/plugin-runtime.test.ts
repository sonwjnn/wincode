import { expect, test } from "bun:test";
import { z } from "zod";
import {
	createPluginRuntime,
	type LoadedPlugin,
} from "@/modules/plugins/runtime";
import type { PluginSessionHistoryPersistence } from "@/modules/sessions/session-plugin-history";
import { toSessionHistoryEntryId } from "@/shared/identifiers";
import { createEmptyPluginRuntime } from "../support/plugin-runtime";
import { successfulSessionWriteOutcome } from "../support/session-write-store";

const pluginSource = "/plugins/jira.ts";
const workspace = "/workspace";

const jiraPlugin = (): LoadedPlugin => ({
	commands: [
		{
			description: "Create a Jira issue.",
			handler: async ({ argument }) => `Created ${argument}`,
			name: "create_issue",
			pluginId: "jira",
			sourcePath: pluginSource,
			value: "/create_issue",
		},
	],
	id: "jira",
	onSessionStart: ({ sessionId }) => {
		if (sessionId === "failed-session") {
			throw new Error("Jira initialization failed");
		}
	},
	sourcePath: pluginSource,
	tools: [
		{
			description: "Search Jira issues.",
			handler: async () => ({ output: { query: "fixed" }, type: "success" }),
			inputSchema: z.object({ query: z.string() }),
			localName: "search_issues",
			name: "plugin_jira_search_issues",
			pluginId: "jira",
			sourcePath: pluginSource,
		},
	],
	workspace,
});

test("a failed process start still runs cleanup for partially initialized resources", async () => {
	const events: string[] = [];
	const runtime = createPluginRuntime(
		[
			{
				commands: [],
				id: "partial-process-start",
				onStart: () => {
					events.push("start");
					throw new Error("initialization failed");
				},
				onShutdown: () => {
					events.push("shutdown");
				},
				sourcePath: pluginSource,
				tools: [],
				workspace,
			},
		],
		[]
	);

	try {
		await runtime.start();
		await runtime.shutdown();
		expect(events).toEqual(["start", "shutdown"]);
	} finally {
		await runtime.shutdown();
	}
});

test("One-Shot can await background work registered by any Plugin for its Session", async () => {
	const runtime = createEmptyPluginRuntime();
	const deferred = Promise.withResolvers<void>();
	let complete = false;
	runtime.registerBackgroundWork("background-session", deferred.promise);
	const waiting = runtime
		.waitForBackgroundWork("background-session")
		.then(() => {
			complete = true;
		});

	try {
		await Promise.resolve();
		expect(complete).toBe(false);
		deferred.resolve();
		await waiting;
		expect(complete).toBe(true);
	} finally {
		await runtime.shutdown();
	}
});

test("a failed later Session registration keeps earlier tools available for that Session", async () => {
	const sessionContext = { sessionId: "partial-session", workspace };
	let shutdownCalled = false;
	const plugin: LoadedPlugin = {
		commands: [],
		id: "jira",
		onSessionShutdown: () => {
			shutdownCalled = true;
		},
		onSessionStart: (_context, api) => {
			api.registerTool({
				description: "A valid earlier registration.",
				handler: async () => ({ output: {}, type: "success" }),
				inputSchema: z.object({}),
				name: "kept_tool",
			});
			api.registerTool({
				description: "An invalid later registration.",
				handler: async () => ({ output: {}, type: "success" }),
				inputSchema: z.object({}),
				name: "",
			});
		},
		sourcePath: pluginSource,
		tools: [],
		workspace,
	};
	const runtime = createPluginRuntime([plugin], []);

	try {
		await runtime.startSession(sessionContext);

		expect(
			runtime
				.getToolDescriptors(sessionContext.sessionId)
				.map(({ localName }) => localName)
		).toEqual(["kept_tool"]);
		expect(runtime.diagnostics).toHaveLength(1);
		await runtime.stopSession(sessionContext);
		expect(shutdownCalled).toBe(true);
	} finally {
		await runtime.shutdown();
	}
});

test("a scoped Plugin registration rejects duplicate model-visible names", async () => {
	const sessionContext = { sessionId: "duplicate-tools-session", workspace };
	const plugin: LoadedPlugin = {
		commands: [],
		id: "duplicate_tools",
		onSessionStart: (_context, api) => {
			api.registerTool({
				description: "The first tool keeps the shared model name.",
				handler: async () => ({ output: {}, type: "success" }),
				inputSchema: z.object({}),
				modelName: "shared_lookup",
				name: "first_lookup",
			});
			api.registerTool({
				description: "The duplicate tool must not be published.",
				handler: async () => ({ output: {}, type: "success" }),
				inputSchema: z.object({}),
				modelName: "shared_lookup",
				name: "second_lookup",
			});
		},
		sourcePath: pluginSource,
		tools: [],
		workspace,
	};
	const runtime = createPluginRuntime([plugin], []);

	try {
		await runtime.startSession(sessionContext);

		expect(
			runtime
				.getToolDescriptors(sessionContext.sessionId)
				.map(({ localName, name }) => ({ localName, name }))
		).toEqual([{ localName: "first_lookup", name: "shared_lookup" }]);
		expect(runtime.diagnostics).toEqual([
			expect.objectContaining({
				message: expect.stringContaining("already registered"),
				sourcePath: pluginSource,
			}),
		]);
	} finally {
		await runtime.shutdown();
	}
});

test("Session-bound Plugin commands receive a fresh History capability after Navigation", async () => {
	const appendGenerations: number[] = [];
	const operationId = "command-plugin-history-append";
	const historyPersistence: PluginSessionHistoryPersistence = {
		append: async (_pluginId, input) => {
			appendGenerations.push(input.expectedHistoryGeneration);
			return {
				entryId: toSessionHistoryEntryId("command-plugin-history-entry"),
				writeOutcome: successfulSessionWriteOutcome(input.operationId),
			};
		},
		read: async () => ({ entries: [], readPoint: "command-history-snapshot" }),
	};
	const runtime = createPluginRuntime(
		[
			{
				commands: [
					{
						description: "Append a test history event.",
						handler: async ({ sessionHistory }) => {
							if (sessionHistory === undefined) {
								throw new Error("Missing Session History capability.");
							}
							return sessionHistory.append(
								"command-event",
								{ schemaVersion: 1 },
								operationId
							);
						},
						name: "append_history",
						pluginId: "history_command",
						sourcePath: pluginSource,
						value: "/append_history",
					},
				],
				id: "history_command",
				sourcePath: pluginSource,
				tools: [],
				workspace,
			},
		],
		[]
	);
	const context = { sessionId: "command-history-session", workspace };
	try {
		await runtime.startSession(context, undefined, historyPersistence);
		const firstEntryId = await runtime.executeCommand(
			"history_command",
			"append_history",
			{ argument: "", ...context }
		);
		await runtime.notifySessionHistoryNavigated?.({
			...context,
			fromEntryId: null,
			historyGeneration: 41,
			operationId: "command-history-navigation",
			toEntryId: null,
		});
		const retryEntryId = await runtime.executeCommand(
			"history_command",
			"append_history",
			{ argument: "", ...context }
		);

		expect(retryEntryId).toBe(firstEntryId);
		expect(appendGenerations).toEqual([0, 41]);
	} finally {
		await runtime.shutdown();
	}
});

test("a failed Session start disables Plugin commands and tools only for that Session", async () => {
	const runtime = createPluginRuntime([jiraPlugin()], []);
	const failedSession = { sessionId: "failed-session", workspace };
	const healthySession = { sessionId: "healthy-session", workspace };

	try {
		await runtime.startSession(failedSession);
		await runtime.startSession(healthySession);

		expect(runtime.getToolDescriptors(failedSession.sessionId)).toEqual([]);
		expect(runtime.getToolDescriptors(healthySession.sessionId)).toHaveLength(
			1
		);
		expect(runtime.getCommands(failedSession.sessionId)).toEqual([]);
		expect(
			runtime.getCommands(healthySession.sessionId).map(({ name }) => name)
		).toEqual(["create_issue"]);
		await expect(
			runtime.executeCommand("jira", "create_issue", {
				argument: "WCO-12",
				sessionId: failedSession.sessionId,
				workspace,
			})
		).rejects.toThrow('Plugin command "/create_issue" failed.');
		await expect(
			runtime.executeCommand("jira", "create_issue", {
				argument: "WCO-12",
				sessionId: healthySession.sessionId,
				workspace,
			})
		).resolves.toBe("Created WCO-12");
	} finally {
		await runtime.shutdown();
	}
});
