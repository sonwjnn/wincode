import { describe, expect, test } from "bun:test";
import { getContrastRatio } from "./color-contrast";
import {
	DEFAULT_THEME,
	findThemeByName,
	getAgentColor,
	resolveTheme,
	THEMES,
	type ThemeDefinition,
} from "./themes";

const OPENCODE_THEME_NAMES = [
	"aura",
	"ayu",
	"carbonfox",
	"catppuccin-frappe",
	"catppuccin-macchiato",
	"catppuccin",
	"cobalt2",
	"cursor",
	"dracula",
	"everforest",
	"flexoki",
	"github",
	"gruvbox",
	"kanagawa",
	"lucent-orng",
	"material",
	"matrix",
	"mercury",
	"monokai",
	"nightowl",
	"nord",
	"one-dark",
	"opencode",
	"orng",
	"osaka-jade",
	"palenight",
	"rosepine",
	"solarized",
	"synthwave84",
	"tokyonight",
	"vercel",
	"vesper",
	"zenburn",
] as const;

const THEME_COLOR =
	/^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}(?:[0-9a-f]{2})?|transparent)$/i;

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
		expect(colors.agent).toEqual({
			build: colors.primary,
			plan: colors.planMode,
		});
		expect(colors.filePathBackground).toBe(colors.backgroundMenu);
		expect(colors.fileBadgeBackground).toBe(colors.primary);
		expect(colors.fileBadgeText).toBe(colors.background);
		expect(colors.filePath).toBe("#838383");
		expect(colors.text).toBe("#e0e0e0");
		expect(colors.textMuted).toBe("#949494");
		expect(colors.textDisabled).toBe("#616161");
		expect(colors.thinkingText).toBe("#b2b2b2");
		expect(colors.tool).toBe(colors.textMuted);
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
				tool: "#abcdef",
			},
		}).colors;
		expect(colors.text).toBe("#aaaaaa");
		expect(colors.textMuted).toBe("#bbbbbb");
		expect(colors.textDisabled).toBe("#cccccc");
		expect(colors.backgroundElement).toBe("#121212");
		expect(colors.borderActive).toBe("#dddddd");
		expect(colors.filePath).toBe("#eeeeee");
		expect(colors.tool).toBe("#abcdef");
	});

	test("preserves alpha in derived colors", () => {
		const colors = resolveTheme({
			...definition,
			colors: {
				...definition.colors,
				background: "#00000080",
				borderSubtle: "#40404066",
			},
		}).colors;

		expect(colors.text).toBe("#e0e0e080");
		expect(colors.textMuted).toBe("#94949480");
		expect(colors.textDisabled).toBe("#61616180");
		expect(colors.filePath).toBe("#83838366");
	});

	test("normalizes shorthand derived colors and preserves alpha", () => {
		const colors = resolveTheme({
			...definition,
			colors: {
				...definition.colors,
				background: "#0008",
				borderSubtle: "#468a",
			},
		}).colors;

		expect(colors.text).toBe("#e0e0e088");
		expect(colors.textMuted).toBe("#94949488");
		expect(colors.textDisabled).toBe("#61616188");
		expect(colors.filePath).toBe("#859cb2aa");
	});

	test("chooses accessible badge text for transparent backgrounds", () => {
		const colors = resolveTheme({
			...definition,
			colors: { ...definition.colors, background: "transparent" },
		}).colors;

		expect(["black", "white"]).toContain(colors.fileBadgeText);
		expect(colors.fileBadgeText).not.toBe("transparent");
		expect(
			getContrastRatio(
				definition.colors.primary,
				colors.fileBadgeText as "black" | "white"
			)
		).toBeGreaterThanOrEqual(4.5);
	});

	test("uses a visible tool color for transparent backgrounds", () => {
		const colors = resolveTheme({
			...definition,
			colors: {
				...definition.colors,
				background: "transparent",
				textMuted: undefined,
			},
		}).colors;

		expect(colors.tool).toBe(colors.borderSubtle);
		expect(colors.tool).not.toBe("transparent");
		expect(colors.text).toBe(colors.primary);
		expect(colors.textMuted).toBe(colors.borderSubtle);
		expect(colors.textDisabled).toBe(colors.border);
	});
});

test("contains the pinned OpenCode theme catalog", () => {
	expect(THEMES).toHaveLength(33);
	expect(THEMES.map(({ name }) => name)).toEqual([...OPENCODE_THEME_NAMES]);
});

test("maps OpenCode semantic colors consistently", () => {
	for (const theme of THEMES) {
		for (const color of [
			theme.colors.primary,
			theme.colors.planMode,
			theme.colors.selection,
			theme.colors.thinking,
			theme.colors.thinkingText,
			theme.colors.success,
			theme.colors.error,
			theme.colors.info,
			theme.colors.tool,
			theme.colors.text,
			theme.colors.textMuted,
			theme.colors.textDisabled,
			theme.colors.background,
			theme.colors.backgroundPanel,
			theme.colors.backgroundElement,
			theme.colors.backgroundMenu,
			theme.colors.border,
			theme.colors.borderSubtle,
			theme.colors.borderActive,
		]) {
			expect(color).toMatch(THEME_COLOR);
		}
		expect(theme.colors.tool).not.toBe("transparent");

		expect(theme.colors.selection).toBe(theme.colors.primary);
		expect(theme.colors.planMode).toBe(getAgentColor(theme.colors, "plan"));
		expect(theme.colors.thinking).toBe(getAgentColor(theme.colors, "plan"));
		expect(theme.colors.backgroundMenu).toBe(theme.colors.backgroundElement);
	}
});

test("default theme is opencode", () => {
	expect(DEFAULT_THEME.name).toBe("opencode");
});

test("findThemeByName selects opencode by exact name", () => {
	const nonDefault = resolveTheme({ ...definition, name: "Opencode" });
	const opencode = resolveTheme({ ...definition, name: "opencode" });

	expect(findThemeByName([nonDefault, opencode], "opencode")).toBe(opencode);
});

test("findThemeByName returns undefined when absent", () => {
	expect(
		findThemeByName([resolveTheme(definition)], "opencode")
	).toBeUndefined();
});
