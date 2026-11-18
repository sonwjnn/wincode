import type { PluginFactory } from "@wincode/coding-agent";

const COMPOSITION_PLUGIN_ID = "renderer_composition_example";

const pluginRendererCompositionExample: PluginFactory = (api) => {
	api.definePlugin({ id: COMPOSITION_PLUGIN_ID });
	api.registerToolRenderer(
		(context, next) => {
			if (
				context.originPluginId !== "tool_renderer_fixture" ||
				context.type !== "dynamic-tool"
			) {
				return;
			}
			return (
				<box>
					<text>{`Composed Tool ${context.call.state}`}</text>
					{next()}
				</box>
			);
		},
		{ priority: 30 }
	);
	api.registerMessageRenderer(
		(context, next) => {
			if (
				context.originPluginId !== undefined ||
				context.role !== "assistant"
			) {
				return;
			}
			return (
				<box>
					<text>Composed message starts</text>
					{next()}
					<text>Composed message ends</text>
				</box>
			);
		},
		{ priority: 30 }
	);
	api.registerEntryRenderer(
		(context, next) => {
			if (
				context.originPluginId !== "history_renderer" ||
				context.type !== "status"
			) {
				return;
			}
			return (
				<box>
					<text>Composed entry from another Plugin</text>
					{next()}
				</box>
			);
		},
		{ priority: 30 }
	);
};

export default pluginRendererCompositionExample;
