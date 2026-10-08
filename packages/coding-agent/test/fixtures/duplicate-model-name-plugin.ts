import type { PluginFactory } from "@wincode/coding-agent";
import { z } from "zod";

const duplicateModelNamePlugin: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "duplicate_model_name" });
	const inputSchema = z.object({});
	const handler = async () => ({ output: null, type: "success" as const });
	plugin.registerTool({
		description: "First tool.",
		handler,
		inputSchema,
		modelName: "shared_model_name",
		name: "first",
	});
	plugin.registerTool({
		description: "Second tool.",
		handler,
		inputSchema,
		modelName: "shared_model_name",
		name: "second",
	});
};

export default duplicateModelNamePlugin;
