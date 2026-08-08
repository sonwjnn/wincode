type BaseSpec = { value: string; name: string; description: string };

export type { BaseSpec };

export type CommandSpec = BaseSpec &
	(
		| { kind: "exit" }
		| { kind: "connect" }
		| { kind: "new" }
		| { kind: "dialog"; dialogKey: "sessions" | "theme" | "mcp" }
		| { kind: "models" }
		| { kind: "skills" }
		| { kind: "variants" }
		| { kind: "mode" }
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
		description: "Browse and insert available skills",
		name: "skills",
		value: "/skills",
		kind: "skills",
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
		name: "themes",
		value: "/themes",
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
		description: "Inspect MCP servers and reconnect failures",
		name: "mcp",
		value: "/mcp",
		kind: "dialog",
		dialogKey: "mcp",
	},
	{
		description: "Quit the application",
		name: "exit",
		value: "/exit",
		kind: "exit",
	},
];
