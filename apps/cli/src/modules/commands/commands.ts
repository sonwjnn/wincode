type BaseSpec = { value: string; name: string; description: string };

export type { BaseSpec };

export type CommandSpec = BaseSpec &
	(
		| { kind: "exit" }
		| { kind: "connect" }
		| { kind: "new" }
		| { kind: "compact" }
		| { kind: "compaction" }
		| {
				kind: "dialog";
				dialogKey: "sessions" | "theme" | "mcps" | "permissions";
		  }
		| { kind: "models" }
		| { kind: "skills" }
		| { kind: "variants" }
		| { kind: "agents" }
	);

export const COMMANDS: CommandSpec[] = [
	{
		description: "Start a new conversation",
		name: "new",
		value: "/new",
		kind: "new",
	},
	{
		description: "Compact conversation history",
		name: "compact",
		value: "/compact",
		kind: "compact",
	},
	{
		description: "Open compaction settings",
		name: "compaction",
		value: "/compaction",
		kind: "compaction",
	},
	{
		description: "Switch agents",
		name: "agents",
		value: "/agents",
		kind: "agents",
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
		description: "Enable, disable, and inspect MCP servers",
		name: "mcps",
		value: "/mcps",
		kind: "dialog",
		dialogKey: "mcps",
	},
	{
		description: "Manage tool approvals, temporary grants, and auto mode",
		name: "permissions",
		value: "/permissions",
		kind: "dialog",
		dialogKey: "permissions",
	},
	{
		description: "Quit the application",
		name: "exit",
		value: "/exit",
		kind: "exit",
	},
];
