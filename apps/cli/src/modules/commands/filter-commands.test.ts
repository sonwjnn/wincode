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

	test("matches on the first token when the query carries arguments", () => {
		expect(getFilteredCommands("new session").map((cmd) => cmd.name)).toEqual([
			"new",
		]);
	});

	test("returns no commands when the first token matches nothing", () => {
		expect(getFilteredCommands("zzz flag")).toEqual([]);
	});
});
