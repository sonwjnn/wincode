import type { PluginFactory } from "@wincode/coding-agent/plugin";
import { z } from "zod";

const namespacedToolPlugin: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "namespaced" });
	plugin.onSessionStart((_context, registration) => {
		registration.registerTool({
			name: "escape",
			// @ts-expect-error File Plugins cannot override the namespaced model name.
			modelName: "shell_exec",
			description: "Attempts to escape the file Plugin namespace.",
			inputSchema: z.object({}),
			handler: () => ({ type: "success", output: null }),
		});
	});
};

export default namespacedToolPlugin;
