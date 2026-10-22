import { describe, expect, test } from "bun:test";
import { getColorContrastRatio } from "@/shared/providers/theme/color-contrast";
import { DIFF_TOKEN_OVERRIDES } from "@/shared/providers/theme/diff-token-overrides";
import { MARKDOWN_TOKEN_OVERRIDES } from "@/shared/providers/theme/markdown-token-overrides";
import type { ThemeDefinition } from "@/shared/providers/theme/themes";
import {
	DEFAULT_THEME,
	findThemeByName,
	getThinkingLevelBorderColor,
	getThinkingLevelColor,
	resolveTheme,
	THEMES,
} from "@/shared/providers/theme/themes";

const MINIMAL_COLORS: ThemeDefinition["colors"] = {
	primary: "#fab283",
	secondary: "#5c9cf5",
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

const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

const THINKING_BORDER_COLOR_KEYS = [
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"thinkingMax",
] as const;

const COLOR_RE = /^(?:transparent|#[\da-f]{3,4}|#[\da-f]{6}(?:[\da-f]{2})?)$/iu;

const HEX_COLOR_RE = /^#([\da-f]{3,4}|[\da-f]{6}(?:[\da-f]{2})?)$/i;
const SOLID_HEX_COLOR_RE = /^#[\da-f]{6}$/iu;

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

	test("uses distinct theme palette colors for each thinking level", () => {
		const theme = resolveTheme({
			name: "custom",
			colors: MINIMAL_COLORS,
		});

		expect(theme.colors.thinkingOff).toBe(MINIMAL_COLORS.border);
		expect(theme.colors.thinkingMinimal).toBe(MINIMAL_COLORS.borderSubtle);
		expect(theme.colors.thinkingLow).toBe(MINIMAL_COLORS.primary);
		expect(theme.colors.thinkingMedium).toBe(MINIMAL_COLORS.secondary);
		expect(theme.colors.thinkingHigh).toBe(MINIMAL_COLORS.info);
		expect(theme.colors.thinkingXhigh).toBe(MINIMAL_COLORS.thinking);
		expect(theme.colors.thinkingMax).toBe(MINIMAL_COLORS.error);
		expect(
			new Set(THINKING_BORDER_COLOR_KEYS.map((key) => theme.colors[key])).size
		).toBe(7);
		expect(getThinkingLevelColor(theme.colors, "low")).toBe(
			theme.colors.thinkingLow
		);
		expect(getThinkingLevelColor(theme.colors, "max")).toBe(
			theme.colors.thinkingMax
		);
	});

	test("uses the theme border color for a visible off-level border", () => {
		const theme = resolveTheme({
			name: "custom",
			colors: MINIMAL_COLORS,
		});

		expect(getThinkingLevelColor(theme.colors, "off")).toBe(
			MINIMAL_COLORS.border
		);
		expect(getThinkingLevelBorderColor(theme.colors, "off")).toBe("#48484899");
	});

	test("ramps thinking border opacity from 60% at off to 100% at max", () => {
		const theme = resolveTheme({
			name: "custom",
			colors: MINIMAL_COLORS,
		});
		const alphas = THINKING_LEVELS.map((level) =>
			Number.parseInt(
				getThinkingLevelBorderColor(theme.colors, level).slice(-2),
				16
			)
		);

		expect(alphas[0]).toBe(153);
		expect(alphas.at(-1)).toBe(255);
		expect(alphas).toEqual([...alphas].sort((first, second) => first - second));
	});

	test("allows explicit thinking-level border color overrides", () => {
		const theme = resolveTheme({
			name: "custom",
			colors: {
				...MINIMAL_COLORS,
				thinkingLow: "#123456",
				thinkingXhigh: "#abcdef",
				thinkingMax: "#fedcba",
			},
		});

		expect(theme.colors.thinkingLow).toBe("#123456");
		expect(theme.colors.thinkingXhigh).toBe("#abcdef");
		expect(theme.colors.thinkingMax).toBe("#fedcba");
	});

	test("hue-shifts conflicting accents without borrowing neutral or background colors", () => {
		const repeatedAccent = "#123456";
		const theme = resolveTheme({
			name: "repeated-accent",
			colors: {
				...MINIMAL_COLORS,
				primary: repeatedAccent,
				secondary: repeatedAccent,
				thinking: repeatedAccent,
				info: repeatedAccent,
				warning: repeatedAccent,
				success: repeatedAccent,
				error: repeatedAccent,
				selection: repeatedAccent,
			},
		});

		const thinkingColors = THINKING_BORDER_COLOR_KEYS.map(
			(key) => theme.colors[key]
		);
		expect(new Set(thinkingColors).size).toBe(7);
		expect(
			thinkingColors.every((color) => SOLID_HEX_COLOR_RE.test(color))
		).toBe(true);
	});

	test("hue-shifts Ayu's near-blue accents and keeps max red", () => {
		const theme = findThemeByName(THEMES, "ayu");
		expect(theme).toBeDefined();
		if (theme === undefined) {
			return;
		}

		expect(theme.colors.thinkingLow).toBe(theme.colors.primary);
		expect(theme.colors.thinkingHigh).not.toBe(theme.colors.info);
		expect(theme.colors.thinkingHigh).not.toBe(theme.colors.thinkingLow);
		expect(theme.colors.thinkingMax).toBe(theme.colors.error);
	});

	test("keeps every theme border visible against its element surface", () => {
		for (const theme of THEMES) {
			if (!HEX_COLOR_RE.test(theme.colors.backgroundElement)) {
				continue;
			}
			expect(
				getColorContrastRatio(
					theme.colors.backgroundElement,
					theme.colors.border
				),
				`${theme.name}.border`
			).toBeGreaterThanOrEqual(3);
		}
	});

	test("resolves every bundled theme with a distinct thinking border palette", () => {
		for (const theme of THEMES) {
			const thinkingColors = THINKING_BORDER_COLOR_KEYS.map(
				(key) => theme.colors[key]
			);
			for (const key of THINKING_BORDER_COLOR_KEYS) {
				expect(theme.colors[key], `${theme.name}.${key}`).toMatch(COLOR_RE);
			}
			expect(new Set(thinkingColors).size, theme.name).toBe(7);
		}
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
