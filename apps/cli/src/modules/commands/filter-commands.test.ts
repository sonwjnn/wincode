import { describe, expect, test } from "bun:test";
import { getFilteredCommands } from "./filter-commands";

describe("getFilteredCommands", () => {
	test("returns all commands for an empty query", () => {
		expect(getFilteredCommands("")).toHaveLength(11);
	});

	test("matches commands by name prefix", () => {
		expect(getFilteredCommands("mod").map((cmd) => cmd.name)).toEqual([
			"models",
		]);
	});

	test("returns no commands when the query does not prefix-match", () => {
		expect(getFilteredCommands("new session")).toEqual([]);
		expect(getFilteredCommands("zzz")).toEqual([]);
	});

	test("hides the variants command when the model has no variants", () => {
		const commands = getFilteredCommands("", { hideVariants: true });
		expect(commands.map((cmd) => cmd.name)).not.toContain("variants");
		expect(commands).toHaveLength(10);
		expect(getFilteredCommands("var", { hideVariants: true })).toEqual([]);
		expect(getFilteredCommands("var").map((cmd) => cmd.name)).toEqual([
			"variants",
		]);
	});
});
