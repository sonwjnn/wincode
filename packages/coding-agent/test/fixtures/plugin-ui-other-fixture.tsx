import type { PluginFactory } from "@wincode/coding-agent";

const pluginUiOtherFixture: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "plugin_ui_other_fixture" });
	plugin.registerCommand({
		description: "Compete for the host-wide custom UI slot.",
		name: "other-custom-busy",
		handler: async ({ ui }) => {
			try {
				await ui.custom(() => () => null);
				return "unexpected-success";
			} catch (error) {
				return typeof error === "object" && error !== null && "code" in error
					? String(error.code)
					: "missing-code";
			}
		},
	});
	plugin.registerCommand({
		description: "Request input using an independent Plugin UI owner.",
		name: "other_input",
		handler: async ({ ui }) =>
			(await ui.input("Other Plugin prompt")) ?? "undefined",
	});
};

export default pluginUiOtherFixture;
