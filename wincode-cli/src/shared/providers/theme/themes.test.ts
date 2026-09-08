import { describe, expect, test } from "bun:test";
import { DIFF_TOKEN_OVERRIDES } from "./diff-token-overrides";
import { MARKDOWN_TOKEN_OVERRIDES } from "./markdown-token-overrides";
import type { ThemeDefinition } from "./themes";
import { DEFAULT_THEME, findThemeByName, resolveTheme, THEMES } from "./themes";

const MINIMAL_COLORS: ThemeDefinition["colors"] = {
	primary: "#fab283",
	secondary: "#5c9cf5",
	planMode: "#9d7cd8",
	selection: "#fab283",
	thinking: "#9d7cd8",
	success: "#7fd88f",
	error: "#e06c75",
	warning: "#f5a742",
	info: "#56b6c2",
	background: "#0a0a0a",
	backgroundPanel: "#141414",
	backgroundMenu: "#1e1e1e",
	border: "#484848",
	borderSubtle: "#3c3c3c",
};

const MD_TOKEN_KEYS = [
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdQuote",
	"mdStrong",
	"mdEmph",
	"mdListBullet",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
] as const;

const DIFF_TOKEN_KEYS = [
	"diffAdded",
	"diffRemoved",
	"diffHighlightAdded",
	"diffHighlightRemoved",
	"diffAddedBg",
	"diffRemovedBg",
	"diffContextBg",
	"diffLineNumber",
	"diffAddedLineNumberBg",
	"diffRemovedLineNumberBg",
] as const;

const COLOR_RE = /^(?:transparent|#[\da-f]{3,4}|#[\da-f]{6}(?:[\da-f]{2})?)$/iu;

const HEX_COLOR_RE = /^#([\da-f]{3,4}|[\da-f]{6}(?:[\da-f]{2})?)$/i;

describe("theme token resolution", () => {
	test("fills canonical markdown tokens for themes that do not define them", () => {
		const theme = resolveTheme({
			name: "test",
			colors: MINIMAL_COLORS,
		});

		expect(theme.colors.mdHeading).toBe("#f0c674");
		expect(theme.colors.mdLink).toBe("#81a2be");
		expect(theme.colors.mdLinkUrl).toBe("#808080");
		expect(theme.colors.mdCode).toBe("#56b6c2");
		expect(theme.colors.mdQuote).toBe("#808080");
		expect(theme.colors.mdStrong).toBe("#f5a742");
		expect(theme.colors.mdEmph).toBe("#e5c07b");
		expect(theme.colors.mdListBullet).toBe("#56b6c2");
	});

	test("fills canonical syntax tokens for themes that do not define them", () => {
		const theme = resolveTheme({
			name: "test",
			colors: MINIMAL_COLORS,
		});

		expect(theme.colors.syntaxComment).toBe("#6a9955");
		expect(theme.colors.syntaxKeyword).toBe("#569cd6");
		expect(theme.colors.syntaxFunction).toBe("#dcdcaa");
		expect(theme.colors.syntaxVariable).toBe("#9cdcfe");
		expect(theme.colors.syntaxString).toBe("#ce9178");
		expect(theme.colors.syntaxNumber).toBe("#b5cea8");
		expect(theme.colors.syntaxType).toBe("#4ec9b0");
		expect(theme.colors.syntaxOperator).toBe("#d4d4d4");
		expect(theme.colors.syntaxPunctuation).toBe("#d4d4d4");
	});

	test("keeps per-theme markdown and syntax overrides", () => {
		const theme = resolveTheme({
			name: "test",
			colors: {
				...MINIMAL_COLORS,
				mdHeading: "#123456",
				syntaxKeyword: "#abcdef",
			},
		});

		expect(theme.colors.mdHeading).toBe("#123456");
		expect(theme.colors.syntaxKeyword).toBe("#abcdef");
		// Unrelated tokens still fall back to canonical values.
		expect(theme.colors.mdCode).toBe("#56b6c2");
	});

	test("resolves every bundled theme with complete markdown and syntax tokens", () => {
		for (const theme of THEMES) {
			for (const key of MD_TOKEN_KEYS) {
				expect(theme.colors[key], `${theme.name}.${key}`).toMatch(HEX_COLOR_RE);
			}
		}
	});

	test("every bundled theme has a complete opencode-sourced override entry", () => {
		const overrideNames = Object.keys(MARKDOWN_TOKEN_OVERRIDES);
		expect(overrideNames).toHaveLength(THEMES.length);
		for (const theme of THEMES) {
			const entry = MARKDOWN_TOKEN_OVERRIDES[theme.name];
			expect(entry, theme.name).toBeDefined();
			for (const key of MD_TOKEN_KEYS) {
				expect(entry?.[key], `${theme.name}.${key}`).toMatch(HEX_COLOR_RE);
			}
		}
	});

	test("resolved themes carry their opencode-sourced markdown identity", () => {
		// The default theme is opencode's own asset: heading = its accent, not
		// the shared canonical gold.
		expect(DEFAULT_THEME.colors.mdHeading).toBe("#9d7cd8");
		expect(DEFAULT_THEME.colors.mdLink).toBe("#56b6c2");
		expect(DEFAULT_THEME.colors.mdLinkUrl).toBe("#fab283");
		expect(DEFAULT_THEME.colors.mdCode).toBe("#7fd88f");

		const dracula = findThemeByName(THEMES, "dracula");
		expect(dracula?.colors.mdHeading).toBe("#bd93f9");
		expect(dracula?.colors.syntaxKeyword).toBe("#ff79c6");

		const monokai = findThemeByName(THEMES, "monokai");
		expect(monokai?.colors.mdCode).toBe("#a6e22e");
		expect(monokai?.colors.syntaxKeyword).toBe("#f92672");
	});

	test("resolves every bundled theme with complete diff tokens", () => {
		for (const theme of THEMES) {
			for (const key of DIFF_TOKEN_KEYS) {
				expect(theme.colors[key], `${theme.name}.${key}`).toMatch(COLOR_RE);
			}
		}
	});

	test("every bundled theme has a complete OpenCode diff override entry", () => {
		const overrideNames = Object.keys(DIFF_TOKEN_OVERRIDES);
		expect(overrideNames).toHaveLength(THEMES.length);
		for (const theme of THEMES) {
			const entry = DIFF_TOKEN_OVERRIDES[theme.name];
			expect(entry, theme.name).toBeDefined();
			for (const key of DIFF_TOKEN_KEYS) {
				expect(entry?.[key], `${theme.name}.${key}`).toMatch(COLOR_RE);
			}
		}
	});

	test("resolves the opencode diff palette from its upstream dark asset", () => {
		expect(DEFAULT_THEME.colors.diffAdded).toBe("#4fd6be");
		expect(DEFAULT_THEME.colors.diffRemoved).toBe("#c53b53");
		expect(DEFAULT_THEME.colors.diffHighlightAdded).toBe("#b8db87");
		expect(DEFAULT_THEME.colors.diffHighlightRemoved).toBe("#e26a75");
		expect(DEFAULT_THEME.colors.diffAddedBg).toBe("#20303b");
		expect(DEFAULT_THEME.colors.diffRemovedBg).toBe("#37222c");
		expect(DEFAULT_THEME.colors.diffContextBg).toBe("#141414");
		expect(DEFAULT_THEME.colors.diffLineNumber).toBe("#8f8f8f");
		expect(DEFAULT_THEME.colors.diffAddedLineNumberBg).toBe("#1b2b34");
		expect(DEFAULT_THEME.colors.diffRemovedLineNumberBg).toBe("#2d1f26");
	});

	test("allows explicit diff definition overrides", () => {
		const theme = resolveTheme({
			name: "opencode",
			colors: {
				...MINIMAL_COLORS,
				diffAdded: "#123456",
			},
		});

		expect(theme.colors.diffAdded).toBe("#123456");
		expect(theme.colors.diffRemoved).toBe("#c53b53");
	});

	test("falls back to blended current-theme diff colors for custom themes", () => {
		const theme = resolveTheme({
			name: "custom",
			colors: MINIMAL_COLORS,
		});

		expect(theme.colors.diffAdded).toBe(MINIMAL_COLORS.success);
		expect(theme.colors.diffRemoved).toBe(MINIMAL_COLORS.error);
		expect(theme.colors.diffHighlightAdded).toBe(MINIMAL_COLORS.success);
		expect(theme.colors.diffHighlightRemoved).toBe(MINIMAL_COLORS.error);
		expect(theme.colors.diffAddedBg).toBe("#27372a");
		expect(theme.colors.diffRemovedBg).toBe("#392425");
		expect(theme.colors.diffContextBg).toBe(MINIMAL_COLORS.backgroundPanel);
		expect(theme.colors.diffLineNumber).toBe("#989898");
		expect(theme.colors.diffAddedLineNumberBg).toBe("#1f2820");
		expect(theme.colors.diffRemovedLineNumberBg).toBe("#281d1e");
	});

	test("an explicit theme definition override beats the opencode table", () => {
		const theme = resolveTheme({
			name: "opencode",
			colors: { ...MINIMAL_COLORS, mdHeading: "#123456" },
		});

		expect(theme.colors.mdHeading).toBe("#123456");
	});
});
