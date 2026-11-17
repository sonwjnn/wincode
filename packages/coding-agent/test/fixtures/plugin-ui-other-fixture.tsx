import type {
	PluginFactory,
	PluginUIFooterComponent,
	PluginUIHeaderComponent,
} from "@wincode/coding-agent";

const competingHeader: PluginUIHeaderComponent = () => (
	<text>Other Plugin header</text>
);

const competingFooter: PluginUIFooterComponent = () => (
	<text>Other Plugin footer</text>
);

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
	plugin.registerCommand({
		description: "Set the same local Plugin UI keys from another Plugin.",
		name: "other-ui-contributions",
		handler: ({ ui }) => {
			ui.setStatus("shared", "Other Plugin shared status");
			ui.setStatus("alpha", "Other Plugin alpha status");
			ui.setWidget("shared", ["Other Plugin shared widget"], {
				placement: "aboveEditor",
			});
			ui.setWidget("alpha", ["Other Plugin alpha widget"], {
				placement: "aboveEditor",
			});
			return "other contributions set";
		},
	});
	plugin.registerCommand({
		description: "Clear only this Plugin's namespaced UI contributions.",
		name: "clear-other-ui-contributions",
		handler: ({ ui }) => {
			ui.setStatus("shared", undefined);
			ui.setStatus("alpha", undefined);
			ui.setWidget("shared", undefined);
			ui.setWidget("alpha", undefined);
			return "other contributions cleared";
		},
	});
	plugin.registerCommand({
		description: "Compete for the already-owned Plugin UI chrome.",
		name: "compete-ui-chrome",
		handler: ({ ui }) =>
			JSON.stringify({
				header: ui.setHeader(competingHeader),
				footer: ui.setFooter(competingFooter),
			}),
	});
	plugin.registerCommand({
		description: "Try to clear another Plugin's UI chrome ownership.",
		name: "other-clear-ui-chrome",
		handler: ({ ui }) =>
			JSON.stringify({
				header: ui.setHeader(undefined),
				footer: ui.setFooter(undefined),
			}),
	});
	plugin.registerCommand({
		description: "Claim freed UI chrome without inheriting a prior owner.",
		name: "claim-ui-chrome",
		handler: ({ ui }) =>
			JSON.stringify({
				header: ui.setHeader(competingHeader),
				footer: ui.setFooter(competingFooter),
			}),
	});
	plugin.registerCommand({
		description: "Set presentation controls as a distinct Plugin owner.",
		name: "other-presentation",
		handler: ({ ui }) => {
			ui.setWorkingMessage("Other working message");
			ui.setWorkingVisible(true);
			ui.setWorkingIndicator({ frames: ["O"] });
			ui.setTitle("Other terminal title");
			ui.setHiddenThinkingLabel("Other reasoning label");
			ui.setToolsExpanded(false);
			return String(ui.getToolsExpanded());
		},
	});
};

export default pluginUiOtherFixture;
