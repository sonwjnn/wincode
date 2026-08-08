import { describe, expect, test } from "bun:test";
import { filterCustomCommands } from "./filter";
import type { CustomCommandSpec } from "./types";

const SPECS: CustomCommandSpec[] = [
	{
		description: "Run tests",
		kind: "custom",
		name: "test",
		template: "Run tests",
		value: "/test",
	},
	{
		description: "Review code",
		kind: "custom",
		name: "review",
		template: "Review",
		value: "/review",
	},
];

describe("filterCustomCommands", () => {
	const names = (commands: CustomCommandSpec[]) =>
		commands.map((command) => command.name);

	test("returns all commands for an empty query", () => {
		expect(names(filterCustomCommands(SPECS, ""))).toEqual(["test", "review"]);
	});

	test("matches commands by name prefix", () => {
		expect(names(filterCustomCommands(SPECS, "tes"))).toEqual(["test"]);
	});

	test("matches case-insensitively", () => {
		expect(names(filterCustomCommands(SPECS, "REV"))).toEqual(["review"]);
	});

	test("matches on the first token when the query carries arguments", () => {
		expect(names(filterCustomCommands(SPECS, "test Button"))).toEqual(["test"]);
	});

	test("returns no commands when the first token matches nothing", () => {
		expect(filterCustomCommands(SPECS, "zzz flag")).toEqual([]);
	});
});
