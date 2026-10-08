import type { PluginFactory } from "@wincode/coding-agent";
import { z } from "zod";

const jiraPlugin: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "jira" });
	plugin.registerTool({
		description: "Search Jira issues.",
		handler: async ({ query }) => ({
			output: { query },
			type: "success",
		}),
		inputSchema: z.object({ query: z.string() }),
		name: "search_issues",
	});
	plugin.registerCommand({
		description: "Open a Jira issue.",
		handler: async ({ argument }) => `Opened ${argument}`,
		name: "open-issue",
	});
};

export default jiraPlugin;
