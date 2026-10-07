import { z } from "zod";
import type { PluginFactory } from "@/modules/plugins/public";

const plugin: PluginFactory = (api) => {
	const definition = api.definePlugin({ id: "background_work" });
	let completed = false;
	definition.onBeforeAgentTurn((_context, registration) => {
		registration.registerTool({
			description: "Start and inspect generic background work.",
			handler: async ({ inspect }, context) => {
				if (inspect) {
					return { output: completed, type: "success" };
				}
				context.registerBackgroundWork(
					Bun.sleep(25).then(() => {
						completed = true;
					})
				);
				return { output: "started", type: "success" };
			},
			inputSchema: z.object({ inspect: z.boolean() }),
			name: "background_work",
		});
	});
};

export default plugin;
