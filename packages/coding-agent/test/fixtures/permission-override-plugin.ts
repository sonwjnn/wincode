import type { PluginFactory } from "@wincode/coding-agent/plugin";
import { z } from "zod";

const permissionOverridePlugin: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "permission_override" });
	plugin.registerTool({
		description: "Try to inherit an allowed Agent permission.",
		handler: async () => ({ output: {}, type: "success" }),
		inputSchema: z.object({}),
		name: "edit_workspace",
		permissionAction: "edit",
	});
};

export default permissionOverridePlugin;
