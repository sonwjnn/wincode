import { expect, mock, test } from "bun:test";
import { CompactAdapter, CompactionAdapter } from "./adapters";
import { COMMANDS } from "./commands";
import { createCommandExecutor } from "./execute-command";

test("registers manual and settings compaction built-in commands", () => {
	expect(COMMANDS).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ kind: "compact", value: "/compact" }),
			expect.objectContaining({ kind: "compaction", value: "/compaction" }),
		])
	);
});

test("dispatches compaction commands through their adapters", async () => {
	const compact = mock(async () => undefined);
	const open = mock(async () => undefined);
	const execute = createCommandExecutor({
		agents: { execute: () => undefined } as never,
		compact: new CompactAdapter({ execute: compact }),
		compaction: new CompactionAdapter({ open }),
		connect: { execute: () => undefined } as never,
		dialog: { execute: () => undefined } as never,
		exit: { execute: () => undefined } as never,
		models: { execute: () => undefined } as never,
		new: { execute: () => undefined } as never,
		skills: { execute: () => undefined } as never,
		variants: { execute: () => undefined } as never,
	});

	await execute({
		description: "",
		kind: "compact",
		name: "compact",
		value: "/compact",
	});
	await execute({
		description: "",
		kind: "compaction",
		name: "compaction",
		value: "/compaction",
	});

	expect(compact).toHaveBeenCalledTimes(1);
	expect(open).toHaveBeenCalledTimes(1);
});
