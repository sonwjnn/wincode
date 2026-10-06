import { expect, test } from "bun:test";
import { z } from "zod";
import {
	createPluginRuntime,
	type LoadedPlugin,
} from "@/modules/plugins/runtime";

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
			action: "plugin:jira:search_issues",
			description: "Search Jira issues.",
			handler: async () => ({ query: "fixed" }),
			inputSchema: z.object({ query: z.string() }),
			localName: "search_issues",
			name: "plugin_jira_search_issues",
			pluginId: "jira",
			sourcePath: pluginSource,
		},
	],
	workspace,
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
