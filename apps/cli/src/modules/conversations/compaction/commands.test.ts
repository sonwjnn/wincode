import { expect, test } from "bun:test";
import {
	isCompactionSettingsCommand,
	isSettingsCommand,
	parseCompactCommand,
} from "./commands";

test("parses exact compact commands and public focus text", () => {
	expect(parseCompactCommand("/compact")).toEqual({});
	expect(parseCompactCommand("  /compact preserve the API decision  ")).toEqual(
		{
			focus: "preserve the API decision",
		}
	);
	expect(parseCompactCommand("/compactible")).toBeNull();
});

test("recognizes the settings command exactly", () => {
	expect(isCompactionSettingsCommand(" /compaction ")).toBe(true);
	expect(isCompactionSettingsCommand("/compaction now")).toBe(false);
});

test("recognizes the global settings command exactly", () => {
	expect(isSettingsCommand(" /settings ")).toBe(true);
	expect(isSettingsCommand("/settings now")).toBe(false);
});
