import type { PluginFactory } from "@wincode/coding-agent";

const jsonSchemaPlugin: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "json_schema" });
	plugin.registerTool({
		description: "A Plugin Tool validated by JSON Schema.",
		handler: (input) => ({ output: input, type: "success" }),
		inputSchema: {
			jsonSchema: {
				additionalProperties: false,
				properties: { query: { type: "string" } },
				required: ["query"],
				type: "object",
			},
			validate: (input) =>
				typeof input === "object" &&
				input !== null &&
				"query" in input &&
				typeof input.query === "string"
					? { success: true, value: input }
					: { error: new Error("query must be a string"), success: false },
		},
		name: "search",
	});
};

export default jsonSchemaPlugin;
