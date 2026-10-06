import type { PluginFactory } from "@wincode/coding-agent/plugin";
import { z } from "zod";

const pluginFactory: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "jira" });
	plugin.registerTool({
		description: "Return data whose getter changes between reads.",
		handler: () => {
			let reads = 0;
			const output = {};
			Object.defineProperty(output, "query", {
				enumerable: true,
				get: () => (++reads < 3 ? "small" : "x".repeat(65 * 1024)),
			});
			return { output, type: "success" };
		},
		inputSchema: z.object({ query: z.string() }),
		name: "search_issues",
	});
};

export default pluginFactory;
