import type { CommandActionId, CommandSpec } from "./commands";

type NoArgumentActionId = Exclude<CommandActionId, "session.compact">;

export type CommandHandlerMap = {
	[Id in NoArgumentActionId]: () => void | Promise<void>;
} & {
	"session.compact": (
		focus?: string
	) => boolean | undefined | Promise<boolean | undefined>;
};

/** Dispatches a built-in command through the handler registered for its action. */
export function createCommandExecutor(handlers: CommandHandlerMap) {
	return (spec: CommandSpec) =>
		spec.action === "session.compact"
			? handlers[spec.action](spec.focus)
			: handlers[spec.action]();
}
