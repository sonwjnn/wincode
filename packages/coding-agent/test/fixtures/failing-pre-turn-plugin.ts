import type { PluginFactory } from "@wincode/coding-agent/plugin";
import { z } from "zod";

const failingPreTurnPlugin: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "failing_pre_turn" });
	plugin.registerTool({
		description: "Factory contribution must be omitted after hook failure.",
		handler: () => ({ output: "factory", type: "success" }),
		inputSchema: z.object({}),
		name: "lookup",
	});
	plugin.onBeforeAgentTurn((_context, scope) => {
		scope.registerTool({
			description: "Turn contribution must be omitted after hook failure.",
			handler: () => ({ output: "turn", type: "success" }),
			inputSchema: z.object({}),
			name: "lookup",
		});
		throw new Error("intentional pre-Turn failure");
	});
};

export default failingPreTurnPlugin;
