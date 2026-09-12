import { expect, mock, test } from "bun:test";
import { CompactAdapter } from "./adapters";
import { createCommandExecutor } from "./execute-command";

test("dispatches manual compaction through its adapter", async () => {
	const compact = mock(async () => undefined);
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
		kind: "compact",
		name: "compact",
		value: "/compact",
	});

	expect(compact).toHaveBeenCalledTimes(1);
});
