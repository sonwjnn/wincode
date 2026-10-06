import type { PluginFactory } from "@wincode/coding-agent/plugin";
import { z } from "zod";

const pluginFactory: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "jira" });
	plugin.registerTool({
		description: "Return an array with an unstable serializer.",
		handler: () => {
			let serializations = 0;
			const output = ["small"];
			Object.defineProperty(output, "toJSON", {
				value: () => (++serializations === 1 ? "small" : "x".repeat(65 * 1024)),
			});
			return { output, type: "success" };
		},
		inputSchema: z.object({ query: z.string() }),
		name: "search_issues",
	});
};

export default pluginFactory;
