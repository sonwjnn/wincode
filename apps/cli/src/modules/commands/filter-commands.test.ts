import { describe, expect, test } from "bun:test";
import { getFilteredCommands } from "./filter-commands";

describe("getFilteredCommands", () => {
	test("returns all commands for an empty query", () => {
		expect(getFilteredCommands("")).toHaveLength(10);
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
});
