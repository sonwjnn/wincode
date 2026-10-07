import type { PluginFactory } from "@wincode/coding-agent/plugin";
import { z } from "zod";

const scopedPlugin: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "scoped" });
	plugin.registerTool({
		description: "Factory version.",
		handler: () => ({ output: "factory", type: "success" }),
		inputSchema: z.object({}),
		name: "lookup",
	});
	plugin.onSessionStart((_context, scope) => {
		scope.registerTool({
			description: "Session version.",
			handler: () => ({ output: "session", type: "success" }),
			inputSchema: z.object({}),
			name: "lookup",
		});
	});
	let turn = 0;
	plugin.onBeforeAgentTurn((_context, scope) => {
		turn += 1;
		if (turn === 1) {
			scope.registerTool({
				description: "Turn version.",
				handler: () => ({ output: "turn", type: "success" }),
				inputSchema: z.object({}),
				name: "lookup",
			});
		} else if (turn === 2) {
			scope.unregisterTool("lookup");
		}
	});
};

export default scopedPlugin;
