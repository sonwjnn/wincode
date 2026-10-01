import type {
	CommandActionId,
	CommandDefinitionFor,
	CommandSpec,
} from "./commands";
import { isOptionalTextCommand } from "./commands";

type CommandHandler<Action extends CommandActionId> =
	CommandDefinitionFor<Action>["input"] extends { kind: "optional-text" }
		? (argument?: string) => unknown
		: () => unknown;

export type CommandHandlerMap = {
	[Action in CommandActionId]: CommandHandler<Action>;
};

/** Dispatches a built-in command through the handler registered for its action. */
export function createCommandExecutor(handlers: CommandHandlerMap) {
	return (spec: CommandSpec) => {
		if (isOptionalTextCommand(spec)) {
			return handlers[spec.action](spec.argument);
		}
		return handlers[spec.action]();
	};
}
