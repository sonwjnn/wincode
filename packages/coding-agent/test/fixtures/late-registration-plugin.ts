import type { PluginFactory } from "@wincode/coding-agent/plugin";
import { z } from "zod";

const lateRegistrationPlugin: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "late_registration" });
	plugin.registerTool({
		description: "Earlier valid registration remains available.",
		handler: () => ({ output: "valid", type: "success" }),
		inputSchema: z.object({}),
		name: "valid_tool",
	});
	try {
		plugin.registerTool({
			description:
				"An invalid later registration must not clear earlier tools.",
			handler: () => ({ output: "invalid", type: "success" }),
			inputSchema: z.object({}),
			name: "invalid-name",
		});
	} catch {
		// The host reports the rejected registration independently.
	}
};

export default lateRegistrationPlugin;
