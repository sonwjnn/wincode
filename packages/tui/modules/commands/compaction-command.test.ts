import { expect, mock, test } from "bun:test";
import { CompactAdapter } from "./adapters";
import { createCommandExecutor } from "./execute-command";

test("dispatches manual compaction focus through its adapter", async () => {
	const compact = mock(async (_focus?: string) => undefined);
	const execute = createCommandExecutor({
		agents: { execute: () => undefined } as never,
		compact: new CompactAdapter({ execute: compact }),
		connect: { execute: () => undefined } as never,
		dialog: { execute: () => undefined } as never,
		exit: { execute: () => undefined } as never,
		models: { execute: () => undefined } as never,
		new: { execute: () => undefined } as never,
		settings: { execute: () => undefined } as never,
		skills: { execute: () => undefined } as never,
	});

	await execute({
		description: "",
		focus: "preserve database decisions",
		kind: "compact",
		name: "compact",
		value: "/compact",
	});

	expect(compact).toHaveBeenCalledWith("preserve database decisions");
	expect(compact).toHaveBeenCalledTimes(1);
});
