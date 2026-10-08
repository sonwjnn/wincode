import type { PluginFactory } from "@wincode/coding-agent";
import { z } from "zod";

const healthyPreTurnPlugin: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "healthy_pre_turn" });
	plugin.onBeforeAgentTurn((_context, scope) => {
		scope.registerTool({
			description: "Healthy Turn-scoped contribution.",
			handler: () => ({ output: "healthy", type: "success" }),
			inputSchema: z.object({}),
			name: "lookup",
		});
	});
};

export default healthyPreTurnPlugin;
