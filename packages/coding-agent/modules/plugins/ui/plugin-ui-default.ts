import type { PluginThemeChangeResult, PluginUI } from "../public";

const unsupportedThemeChange: PluginThemeChangeResult = Object.freeze({
	error: "Theme changes are available only in Interactive Mode.",
	success: false,
});

/** UI defaults used without an Interactive UI host, including JSON, Print, and RPC. */
export const unsupportedPluginUI: PluginUI = Object.freeze({
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	editor: async () => undefined,
	notify: () => undefined,
	getAllThemes: () => [],
	getTheme: () => undefined,
	setTheme: () => unsupportedThemeChange,
});
