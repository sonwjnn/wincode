import { describe, expect, test } from "bun:test";
import {
	DEFAULT_THEME,
	resolveTheme,
	THEMES,
	type ThemeDefinition,
} from "./themes";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const definition: ThemeDefinition = {
	name: "Test",
	colors: {
		primary: "#112233",
		planMode: "#223344",
		selection: "#334455",
		thinking: "#445566",
		success: "#556677",
		error: "#667788",
		info: "#778899",
		background: "#000000",
		backgroundPanel: "#101010",
		backgroundMenu: "#202020",
		border: "#303030",
		borderSubtle: "#404040",
	},
};

describe("resolveTheme", () => {
	test("fills semantic defaults", () => {
		const colors = resolveTheme(definition).colors;
		expect(colors.backgroundElement).toBe(colors.backgroundPanel);
		expect(colors.borderActive).toBe(colors.primary);
		expect(colors.mode).toEqual({
			build: colors.primary,
			plan: colors.planMode,
		});
		expect(colors.filePathBackground).toBe(colors.backgroundMenu);
		expect(colors.text).toBe("#e0e0e0");
		expect(colors.textMuted).toBe("#949494");
		expect(colors.textDisabled).toBe("#616161");
	});

	test("preserves explicit overrides", () => {
		const colors = resolveTheme({
			...definition,
			colors: {
				...definition.colors,
				text: "#aaaaaa",
				textMuted: "#bbbbbb",
				textDisabled: "#cccccc",
				backgroundElement: "#121212",
				borderActive: "#dddddd",
				filePath: "#eeeeee",
			},
		}).colors;
		expect(colors.text).toBe("#aaaaaa");
		expect(colors.textMuted).toBe("#bbbbbb");
		expect(colors.textDisabled).toBe("#cccccc");
		expect(colors.backgroundElement).toBe("#121212");
		expect(colors.borderActive).toBe("#dddddd");
		expect(colors.filePath).toBe("#eeeeee");
	});
});

test("all built-in themes resolve complete semantic colors", () => {
	for (const theme of THEMES) {
		expect(theme.colors.text).toMatch(HEX_COLOR);
		expect(theme.colors.backgroundElement).toBeTruthy();
		expect(theme.colors.borderActive).toBeTruthy();
	}
});

test("default theme is Sonvox", () => {
	expect(DEFAULT_THEME.name).toBe("Sonvox");
});
