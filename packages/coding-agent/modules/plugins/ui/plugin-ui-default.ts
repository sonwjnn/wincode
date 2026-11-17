import type {
	PluginThemeChangeResult,
	PluginUI,
	PluginUIContributionResult,
} from "../public";

const unsupportedThemeChange: PluginThemeChangeResult = Object.freeze({
	error: "Theme changes are available only in Interactive Mode.",
	success: false,
});

const unsupportedContribution: PluginUIContributionResult = Object.freeze({
	success: true,
});

/** UI defaults used without an Interactive UI host, including JSON, Print, and RPC. */
export const unsupportedPluginUI: PluginUI = Object.freeze({
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	editor: async () => undefined,
	custom: async () => undefined,
	setStatus: () => undefined,
	setWidget: () => undefined,
	setHeader: () => unsupportedContribution,
	setFooter: () => unsupportedContribution,
	setTitle: () => undefined,
	setWorkingMessage: () => undefined,
	setWorkingVisible: () => undefined,
	setWorkingIndicator: () => undefined,
	setHiddenThinkingLabel: () => undefined,
	getToolsExpanded: () => false,
	setToolsExpanded: () => undefined,
	onTerminalInput: () => () => undefined,
	notify: () => undefined,
	getAllThemes: () => [],
	getTheme: () => undefined,
	setTheme: () => unsupportedThemeChange,
});
