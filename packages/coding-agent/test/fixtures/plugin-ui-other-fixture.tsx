import type { PluginFactory } from "@wincode/coding-agent";

const pluginUiOtherFixture: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "plugin_ui_other_fixture" });
	plugin.registerCommand({
		description: "Request input using an independent Plugin UI owner.",
		name: "other_input",
		handler: async ({ ui }) =>
			(await ui.input("Other Plugin prompt")) ?? "undefined",
	});
};

export default pluginUiOtherFixture;
