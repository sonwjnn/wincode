import { expect, mock, test } from "bun:test";
import { COMMANDS } from "@/modules/commands/commands";
import {
	type CommandHandlerMap,
	createCommandExecutor,
} from "@/modules/commands/execute-command";

test("dispatches manual compaction focus to its registered action", async () => {
	const compact = mock(async (_focus?: string) => undefined);
	const handlers = {
		"agent.select": () => undefined,
		"application.reload": () => undefined,
		"app.exit": () => undefined,
		"connection.open": () => undefined,
		"dialog.sessions": () => undefined,
		"dialog.theme": () => undefined,
		"thinking.select": () => undefined,
		"model.select": () => undefined,
		"project.trust": () => undefined,
		"session.compact": compact,
		"session.new": () => undefined,
		"settings.open": () => undefined,
	} satisfies CommandHandlerMap;
	const execute = createCommandExecutor(handlers);
	const command = COMMANDS.find(({ action }) => action === "session.compact");
	if (command?.action !== "session.compact") {
		throw new Error("Compaction command missing from the registry.");
	}

	await execute({ ...command, argument: "preserve database decisions" });

	expect(compact).toHaveBeenCalledWith("preserve database decisions");
	expect(compact).toHaveBeenCalledTimes(1);
});
