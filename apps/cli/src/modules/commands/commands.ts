type BaseSpec = { value: string; name: string; description: string };

export type CommandSpec = BaseSpec &
	(
		| { kind: "exit" }
		| { kind: "connect" }
		| { kind: "new" }
		| { kind: "dialog"; dialogKey: "sessions" | "theme" }
		| { kind: "models" }
		| { kind: "variants" }
		| { kind: "mode" }
		| { kind: "unavailable"; message: string }
	);

export const COMMANDS: CommandSpec[] = [
	{
		description: "Start a new conversation",
		name: "new",
		value: "/new",
		kind: "new",
	},
	{
		description: "Switch agents",
		name: "agents",
		value: "/agents",
		kind: "mode",
	},
	{
		description: "Select AI model for generation",
		name: "models",
		value: "/models",
		kind: "models",
	},
	{
		description: "Select model variant",
		name: "variants",
		value: "/variants",
		kind: "variants",
	},
	{
		description: "Browse past sessions",
		name: "sessions",
		value: "/sessions",
		kind: "dialog",
		dialogKey: "sessions",
	},
	{
		description: "Change color theme",
		name: "theme",
		value: "/theme",
		kind: "dialog",
		dialogKey: "theme",
	},
	{
		description: "Connect an account or API key",
		name: "connect",
		value: "/connect",
		kind: "connect",
	},
	{
		description: "Buy more credits",
		name: "upgrade",
		value: "/upgrade",
		kind: "unavailable",
		message:
			"Upgrade is not available in the CLI yet. Use the web app for now.",
	},
	{
		description: "Open billing portal in your browser",
		name: "usage",
		value: "/usage",
		kind: "unavailable",
		message: "Usage is not available in the CLI yet. Use the web app for now.",
	},
	{
		description: "Quit the application",
		name: "exit",
		value: "/exit",
		kind: "exit",
	},
];
