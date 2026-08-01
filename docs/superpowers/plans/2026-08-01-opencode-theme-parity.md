# OpenCode Theme Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Wincode CLI's theme catalog with OpenCode's 33 pinned dark palettes while preserving local color roles and accessibility.

**Architecture:** Keep static `ThemeDefinition` data in `themes.ts`; do not load OpenCode assets at runtime. Extend shared color parsing/derivation to preserve alpha safely, then map OpenCode semantic fields into local roles. Theme tests own catalog and mapping contracts; color-contrast tests own alpha compositing contracts.

**Tech Stack:** TypeScript, Bun test, OpenTUI React, Ultracite.

---

## File Structure

- Modify: `apps/cli/src/shared/providers/theme/themes.ts` — pinned OpenCode catalog, alpha-safe derivation, default theme.
- Modify: `apps/cli/src/shared/providers/theme/themes.test.ts` — catalog, semantic mapping, supported-color, and default contracts.
- Modify: `apps/cli/src/shared/providers/theme/color-contrast.ts` — parse and composite 3/4/6/8-digit colors.
- Modify: `apps/cli/src/shared/providers/theme/color-contrast.test.ts` — alpha contrast regression coverage.

### Task 1: Define failing catalog and alpha contracts

**Files:**
- Modify: `apps/cli/src/shared/providers/theme/themes.test.ts:10-101`
- Modify: `apps/cli/src/shared/providers/theme/color-contrast.test.ts:5-37`

- [ ] **Step 1: Add catalog and mapping tests in `themes.test.ts`**

Add after `definition`:

```ts
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

const THEME_COLOR = /^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}(?:[0-9a-f]{2})?|transparent)$/i;
```

Replace the current built-in theme test with:

```ts
test("contains the pinned OpenCode theme catalog", () => {
	expect(THEMES).toHaveLength(33);
	expect(THEMES.map(({ name }) => name)).toEqual(OPENCODE_THEME_NAMES);
});

test("maps OpenCode semantic colors consistently", () => {
	for (const theme of THEMES) {
		for (const color of [
			theme.colors.primary,
			theme.colors.planMode,
			theme.colors.selection,
			theme.colors.thinking,
			theme.colors.text,
			theme.colors.textMuted,
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

		expect(theme.colors.selection).toBe(theme.colors.primary);
		expect(theme.colors.planMode).toBe(theme.colors.mode.plan);
		expect(theme.colors.thinking).toBe(theme.colors.mode.plan);
		expect(theme.colors.backgroundMenu).toBe(theme.colors.backgroundElement);
	}
});
```

- [ ] **Step 2: Update default and exact lookup tests**

Replace Sonvox-specific assertions with:

```ts
test("default theme is opencode", () => {
	expect(DEFAULT_THEME.name).toBe("opencode");
});

test("findThemeByName selects opencode by exact name", () => {
	const nonDefault = resolveTheme({ ...definition, name: "Opencode" });
	const opencode = resolveTheme({ ...definition, name: "opencode" });

	expect(findThemeByName([nonDefault, opencode], "opencode")).toBe(opencode);
});

test("findThemeByName returns undefined when absent", () => {
	expect(findThemeByName([resolveTheme(definition)], "opencode")).toBeUndefined();
});
```

- [ ] **Step 3: Add alpha derivation and contrast tests**

Add to `resolveTheme` tests:

```ts
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
```

Add to `color-contrast.test.ts`:

```ts
test("supports 8-digit hex colors", () => {
	expect(getContrastingTextColor("#ffffff80")).toBe("black");
	expect(getContrastingTextColor("#00000000")).toBe("white");
});

test("composites alpha colors against black", () => {
	expect(getContrastRatio("#ff000080", "white")).toBeGreaterThan(
		getContrastRatio("#ff000080", "black")
	);
});
```

- [ ] **Step 4: Run focused tests; confirm they fail**

Run: `bun test apps/cli/src/shared/providers/theme/themes.test.ts apps/cli/src/shared/providers/theme/color-contrast.test.ts`

Expected: FAIL because catalog/default/mapping contracts and alpha parsing are not implemented.

### Task 2: Make local color helpers alpha-safe

**Files:**
- Modify: `apps/cli/src/shared/providers/theme/color-contrast.ts:1-47`
- Modify: `apps/cli/src/shared/providers/theme/themes.ts:53-72,621-642`

- [ ] **Step 1: Parse and composite alpha in `color-contrast.ts`**

Replace the RGB-only regex/parser and `getRelativeLuminance` with:

```ts
const HEX_COLOR_RE =
	/^#?(?:(?<shortRed>[\da-f])(?<shortGreen>[\da-f])(?<shortBlue>[\da-f])(?<shortAlpha>[\da-f])?|(?<red>[\da-f]{2})(?<green>[\da-f]{2})(?<blue>[\da-f]{2})(?<alpha>[\da-f]{2})?)$/iu;

type Rgba = {
	red: number;
	green: number;
	blue: number;
	alpha: number;
};

const parseHexColor = (color: string): Rgba | null => {
	const match = color.match(HEX_COLOR_RE);
	if (!match?.groups) {
		return null;
	}

	const short = Boolean(match.groups.shortRed);
	const expand = (value: string) => (short ? `${value}${value}` : value);
	const red = expand(match.groups.shortRed ?? match.groups.red ?? "");
	const green = expand(match.groups.shortGreen ?? match.groups.green ?? "");
	const blue = expand(match.groups.shortBlue ?? match.groups.blue ?? "");
	const alpha = expand(match.groups.shortAlpha ?? match.groups.alpha ?? (short ? "f" : "ff"));

	return {
		red: Number.parseInt(red, 16),
		green: Number.parseInt(green, 16),
		blue: Number.parseInt(blue, 16),
		alpha: Number.parseInt(alpha, 16) / 255,
	};
};

const getRelativeLuminance = (backgroundColor: string): number | null => {
	const color = parseHexColor(backgroundColor);
	if (!color) {
		return null;
	}

	const channels = [color.red, color.green, color.blue].map((channel) => {
		const srgb = (channel * color.alpha) / 255;
		return srgb <= 0.039_28
			? srgb / 12.92
			: ((srgb + 0.055) / 1.055) ** 2.4;
	});

	return (
		0.2126 * (channels[0] ?? 0) +
		0.7152 * (channels[1] ?? 0) +
		0.0722 * (channels[2] ?? 0)
	);
};
```

Retain public function signatures and invalid-input behavior (`getContrastRatio` returns `1`, `getContrastingTextColor` returns `"black"`).

- [ ] **Step 2: Preserve alpha in `brightenColor`**

Replace `brightenColor` with:

```ts
const COLOR_RE =
	/^#(?:(?<shortRed>[\da-f])(?<shortGreen>[\da-f])(?<shortBlue>[\da-f])(?<shortAlpha>[\da-f])?|(?<red>[\da-f]{2})(?<green>[\da-f]{2})(?<blue>[\da-f]{2})(?<alpha>[\da-f]{2})?)$/iu;

const brightenColor = (color: string, amount: number) => {
	// Expand #RGB/#RGBA before brightening; preserve alpha suffix.
	const match = color.match(COLOR_RE);
	if (!match?.groups) {
		return color;
	}

	const short = Boolean(match.groups.shortRed);
	const expand = (value: string) => (short ? `${value}${value}` : value);
	const channels = ["red", "green", "blue"].map((channel) => {
		const value = Number.parseInt(
			expand(match.groups?.[short ? `short${channel[0]?.toUpperCase()}${channel.slice(1)}` : channel] ?? "0"),
			16
		);
		return Math.round(value + (255 - value) * amount)
			.toString(16)
			.padStart(2, "0");
	});

	return `#${channels.join("")}${expand(match.groups.alpha ?? match.groups.shortAlpha ?? "")}`;
};
```

- [ ] **Step 3: Protect transparent file-badge text**

Import `getContrastingTextColor` into `themes.ts`. Change only the `fileBadgeText` fallback in `resolveTheme` so a transparent background chooses readable black/white against `colors.primary`:

```ts
fileBadgeText:
	colors.fileBadgeText ??
	(colors.background === "transparent"
		? getContrastingTextColor(colors.primary)
		: colors.background),
```

- [ ] **Step 4: Run focused tests; confirm alpha contracts pass**

Run: `bun test apps/cli/src/shared/providers/theme/themes.test.ts apps/cli/src/shared/providers/theme/color-contrast.test.ts`

Expected: alpha-specific tests PASS; catalog/default contracts still FAIL until Task 3.

### Task 3: Replace definitions with pinned OpenCode catalog

**Files:**
- Modify: `apps/cli/src/shared/providers/theme/themes.ts:74-619,646-655`

- [ ] **Step 1: Generate exact static definitions from pinned upstream assets**

Run this stdout-only script, then copy its output over `THEME_DEFINITIONS` without committing the script:

```bash
python3 <<'PY'
import json
import urllib.request

SHA = "19231fce4b70aa5f7894a0a0eb20ff29bd417db5"
API = f"https://api.github.com/repos/anomalyco/opencode/git/trees/{SHA}?recursive=1"
RAW = f"https://raw.githubusercontent.com/anomalyco/opencode/{SHA}/"
tree = json.load(urllib.request.urlopen(API))["tree"]
paths = sorted(x["path"] for x in tree if x["path"].startswith("packages/tui/src/theme/assets/") and x["path"].endswith(".json"))

def resolve(value, defs):
    if isinstance(value, str): return defs.get(value, value)
    if isinstance(value, dict): return resolve(value["dark"], defs)
    raise ValueError(f"Unsupported value: {value!r}")

print("const THEME_DEFINITIONS = [")
for path in paths:
    data = json.load(urllib.request.urlopen(RAW + path))
    defs, theme = data.get("defs", {}), data["theme"]
    value = lambda field: json.dumps(resolve(theme[field], defs))
    print("\t{")
    print(f"\t\tname: {json.dumps(path.rsplit('/', 1)[-1][:-5])},")
    print("\t\tcolors: {")
    for local, upstream in (("primary", "primary"), ("planMode", "accent"), ("selection", "primary"), ("thinking", "accent"), ("success", "success"), ("error", "error"), ("info", "info"), ("text", "text"), ("textMuted", "textMuted"), ("background", "background"), ("backgroundPanel", "backgroundPanel"), ("backgroundElement", "backgroundElement"), ("backgroundMenu", "backgroundElement"), ("border", "border"), ("borderSubtle", "borderSubtle"), ("borderActive", "borderActive")):
        print(f"\t\t\t{local}: {value(upstream)},")
    print("\t\t},\n\t},")
print("] satisfies ThemeDefinition[];")
PY
```

- [ ] **Step 2: Set canonical default**

Replace:

```ts
export const SONVOX_THEME_NAME = "Sonvox";
```

with:

```ts
export const OPENCODE_THEME_NAME = "opencode";
```

Update the default lookup/error interpolation to use `OPENCODE_THEME_NAME`.

- [ ] **Step 3: Run focused tests; confirm catalog contracts pass**

Run: `bun test apps/cli/src/shared/providers/theme/themes.test.ts apps/cli/src/shared/providers/theme/color-contrast.test.ts`

Expected: PASS.

### Task 4: Verify CLI integration and formatting

**Files:**
- Modify only files from Tasks 1-3 if formatter changes them.

- [ ] **Step 1: Format changed TypeScript**

Run: `bun x ultracite fix apps/cli/src/shared/providers/theme/themes.ts apps/cli/src/shared/providers/theme/themes.test.ts apps/cli/src/shared/providers/theme/color-contrast.ts apps/cli/src/shared/providers/theme/color-contrast.test.ts`

Expected: command succeeds.

- [ ] **Step 2: Re-run focused theme tests**

Run: `bun test apps/cli/src/shared/providers/theme/themes.test.ts apps/cli/src/shared/providers/theme/color-contrast.test.ts apps/cli/src/shared/providers/theme/theme-consumers.test.ts`

Expected: PASS.

- [ ] **Step 3: Typecheck CLI**

Run: `bun run --cwd apps/cli check-types`

Expected: exit code 0.

- [ ] **Step 4: Run root quality check**

Run: `bun run check`

Expected: exit code 0.

- [ ] **Step 5: Inspect final diff and status**

Run: `git diff -- apps/cli/src/shared/providers/theme docs/superpowers && git status --short`

Expected: only approved theme, test, and design/plan changes; preserve pre-existing unrelated conversation UI edits.

## Plan Self-Review

- Spec coverage: Tasks 1-3 cover 33 pinned dark themes, semantic mapping, `opencode` default, alpha/transparent safety, and local badge accessibility. Task 4 covers focused and integration verification.
- Placeholder scan: no unresolved markers or implicit test steps.
- Type consistency: `OPENCODE_THEME_NAME`, `ThemeDefinition`, `getContrastRatio`, and `getContrastingTextColor` retain existing public names/signatures.
