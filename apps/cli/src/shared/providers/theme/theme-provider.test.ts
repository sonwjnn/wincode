import { describe, expect, test } from "bun:test";
import {
	parseThemePreference,
	serializeThemePreference,
} from "./theme-provider";
import { DEFAULT_THEME } from "./themes";

describe("parseThemePreference", () => {
	const validPreference = JSON.stringify({ themeName: DEFAULT_THEME.name });

	test.each([
		"not json",
		"null",
		"{}",
		'{"themeName": "unknown"}',
		'{"themeName": 1}',
	])("returns default for malformed or invalid preference %s", (raw) => {
		expect(parseThemePreference(raw)).toBe(DEFAULT_THEME);
	});

	test("returns matching theme for valid preference", () => {
		expect(parseThemePreference(validPreference)).toBe(DEFAULT_THEME);
	});
});

test("serializeThemePreference preserves formatted JSON", () => {
	expect(serializeThemePreference({ name: "Solarized" })).toBe(
		'{\n  "themeName": "Solarized"\n}'
	);
});
