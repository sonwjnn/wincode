import type { BaseSpec } from "./types";

export const COMMANDS = [
	{
		description: "Start a new session",
		name: "new",
		value: "/new",
		kind: "builtin",
		action: "session.new",
	},
	{
		description: "Compact session history",
		name: "compact",
		value: "/compact",
		kind: "builtin",
		action: "session.compact",
	},
	{
		description: "Open application settings",
		name: "settings",
		value: "/settings",
		kind: "builtin",
		action: "settings.open",
	},
	{
		description: "Switch agents",
		name: "agents",
		value: "/agents",
		kind: "builtin",
		action: "agent.select",
	},
	{
		description: "Select AI model for generation",
		name: "models",
		value: "/models",
		kind: "builtin",
		action: "model.select",
	},
	{
		description: "Select Effort or Reasoning Mode",
		name: "effort",
		value: "/effort",
		kind: "builtin",
		action: "effort.select",
	},
	{
		description: "Browse past sessions",
		name: "sessions",
		value: "/sessions",
		kind: "builtin",
		action: "dialog.sessions",
	},
	{
		description: "Change color theme",
		name: "themes",
		value: "/themes",
		kind: "builtin",
		action: "dialog.theme",
	},
	{
		description: "Connect an account or API key",
		name: "connect",
		value: "/connect",
		kind: "builtin",
		action: "connection.open",
	},
	{
		description: "Enable, disable, and inspect MCP servers",
		name: "mcps",
		value: "/mcps",
		kind: "builtin",
		action: "dialog.mcps",
	},
	{
		description: "Quit the application",
		name: "exit",
		value: "/exit",
		kind: "builtin",
		action: "app.exit",
	},
] as const satisfies readonly (BaseSpec & {
	kind: "builtin";
	action: string;
})[];

const registeredActions = new Set<string>();
const registeredNames = new Set<string>();
for (const command of COMMANDS) {
	const name = command.name.toLowerCase();
	if (registeredActions.has(command.action)) {
		throw new Error(`Duplicate built-in command action: ${command.action}`);
	}
	if (registeredNames.has(name)) {
		throw new Error(`Duplicate built-in command name: ${command.name}`);
	}
	registeredActions.add(command.action);
	registeredNames.add(name);
}

export type CommandActionId = (typeof COMMANDS)[number]["action"];

export type CommandSpec = BaseSpec & { kind: "builtin" } & (
		| { action: "session.compact"; focus?: string }
		| { action: Exclude<CommandActionId, "session.compact"> }
	);

/**
 * Built-in Commands whose popover row is offered in the current view. Hidden
 * kinds stay reachable by typing their name; only the row is suppressed.
 */
export const getVisibleCommands = (
	options: { hideCompact?: boolean; hideEffort?: boolean } = {}
): CommandSpec[] =>
	COMMANDS.filter(
		(command) =>
			!(
				(options.hideCompact && command.action === "session.compact") ||
				(options.hideEffort && command.action === "effort.select")
			)
	);
