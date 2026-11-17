import type { PluginUI, PluginUIPromptKind } from "../public";

export type PluginUIOwner = Readonly<{
	pluginId: string;
	sessionId?: string;
}>;

export type PluginUIHandle = Readonly<{
	close: () => void;
	ui: PluginUI;
}>;

export type PluginUIUpdate =
	| Readonly<{
			type: "status";
			pluginId: string;
			key: string;
			value: string | null;
	  }>
	| Readonly<{
			type: "widget";
			pluginId: string;
			key: string;
			value: readonly string[] | null;
			placement: "aboveEditor" | "belowEditor";
	  }>
	| Readonly<{
			type: "title";
			pluginId: string;
			value: string | null;
	  }>;

/** The UI-neutral host surface used by Interactive and RPC execution modes. */
export type PluginUIHostBinding = Readonly<{
	close: () => void;
	create: (
		owner: PluginUIOwner,
		beginPrompt: (kind: PluginUIPromptKind, title: string) => () => void,
		invocation: "command" | "event"
	) => PluginUIHandle;
	update?: (update: PluginUIUpdate) => void;
}>;
