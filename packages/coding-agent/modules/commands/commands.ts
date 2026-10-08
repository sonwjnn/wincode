import type { BaseSpec } from "./types";

const NO_INPUT = { kind: "none" } as const;

export const COMMAND_CAPABILITIES = ["compaction", "effort-selection"] as const;

export type CommandCapability = (typeof COMMAND_CAPABILITIES)[number];

export const COMMANDS = [
	{
		description: "Start a new session",
		name: "new",
		value: "/new",
		kind: "builtin",
		action: "session.new",
		input: NO_INPUT,
	},
	{
		description: "Compact session history",
		name: "compact",
		value: "/compact",
		kind: "builtin",
		action: "session.compact",
		input: { kind: "optional-text" as const, name: "focus" },
		requires: ["compaction"],
	},
	{
		description: "Open application settings",
		name: "settings",
		value: "/settings",
		kind: "builtin",
		action: "settings.open",
		input: NO_INPUT,
	},
	{
		description: "Switch agents",
		name: "agents",
		value: "/agents",
		kind: "builtin",
		action: "agent.select",
		input: NO_INPUT,
	},
	{
		description: "Select AI model for generation",
		name: "models",
		value: "/models",
		kind: "builtin",
		action: "model.select",
		input: NO_INPUT,
	},
	{
		description: "Select Effort or Reasoning Mode",
		name: "effort",
		value: "/effort",
		kind: "builtin",
		action: "effort.select",
		input: NO_INPUT,
		requires: ["effort-selection"],
	},
	{
		description: "Browse past sessions",
		name: "sessions",
		value: "/sessions",
		kind: "builtin",
		action: "dialog.sessions",
		input: NO_INPUT,
	},
	{
		description: "Change color theme",
		name: "themes",
		value: "/themes",
		kind: "builtin",
		action: "dialog.theme",
		input: NO_INPUT,
	},
	{
		description: "Connect an account or API key",
		name: "connect",
		value: "/connect",
		kind: "builtin",
		action: "connection.open",
		input: NO_INPUT,
	},
	{
		description: "Quit the application",
		name: "exit",
		value: "/exit",
		kind: "builtin",
		action: "app.exit",
		input: NO_INPUT,
	},
] as const satisfies readonly (BaseSpec & {
	kind: "builtin";
	action: string;
	input: { kind: "none" } | { kind: "optional-text"; name: string };
	requires?: readonly CommandCapability[];
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
export type CommandDefinition = (typeof COMMANDS)[number];

export type CommandDefinitionFor<Action extends CommandActionId> = Extract<
	CommandDefinition,
	{ action: Action }
>;

type CommandWithoutInput = Extract<
	CommandDefinition,
	{ input: { kind: "none" } }
>;
type OptionalTextCommand = Extract<
	CommandDefinition,
	{ input: { kind: "optional-text" } }
>;

export type CommandSpec =
	| CommandWithoutInput
	| (OptionalTextCommand & { argument?: string });

export const isOptionalTextCommand = (
	command: CommandSpec
): command is OptionalTextCommand & { argument?: string } =>
	command.input.kind === "optional-text";

/**
 * Built-in Commands whose popover row is offered in the current view. Hidden
 * kinds cannot be selected, so they cannot run in that view.
 */
export const getVisibleCommands = (
	options: { unavailableCapabilities?: readonly CommandCapability[] } = {}
): CommandSpec[] =>
	COMMANDS.filter(
		(command) =>
			!("requires" in command) ||
			command.requires.every(
				(capability) => !options.unavailableCapabilities?.includes(capability)
			)
	);
