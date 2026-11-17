import type { PluginFactory } from "@wincode/coding-agent";

const pluginUiOtherFixture: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "plugin_ui_other_fixture" });
	const keyboardState = {
		inputEvents: [] as string[],
		shortcutCalls: 0,
		stopInput: undefined as (() => void) | undefined,
	};
	plugin.registerResource("keyboard_state", keyboardState);
	api.registerShortcut("ctrl+shift+p", {
		description: "Show the other Plugin keyboard fixture shortcut.",
		handler: () => {
			keyboardState.shortcutCalls += 1;
		},
	});
	plugin.registerCommand({
		description:
			"Keep a raw input subscription until it is explicitly removed.",
		name: "listen-other-terminal-input",
		handler: ({ ui }) => {
			keyboardState.stopInput?.();
			keyboardState.stopInput = ui.onTerminalInput((data) => {
				keyboardState.inputEvents.push(data);
			});
			return "listening";
		},
	});
	plugin.registerCommand({
		description: "Remove the other Plugin raw input subscription.",
		name: "stop-other-terminal-input",
		handler: () => {
			keyboardState.stopInput?.();
			keyboardState.stopInput = undefined;
			return "stopped";
		},
	});
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
