import { getContrastingTextColor } from "./color-contrast";

export type ThemeColors = {
	agent: Record<string, string>;
	primary: string;
	planMode: string;
	selection: string;
	thinking: string;
	thinkingText: string;
	tool: string;
	success: string;
	error: string;
	info: string;
	text: string;
	textMuted: string;
	textDisabled: string;
	background: string;
	backgroundPanel: string;
	backgroundElement: string;
	backgroundMenu: string;
	border: string;
	borderSubtle: string;
	borderActive: string;
	fileBadgeBackground: string;
	fileBadgeText: string;
	filePathBackground: string;
	filePath: string;
};

export type Theme = {
	name: string;
	colors: ThemeColors;
};

export type ThemeDefinition = {
	name: string;
	colors: Pick<
		ThemeColors,
		| "primary"
		| "planMode"
		| "selection"
		| "thinking"
		| "success"
		| "error"
		| "info"
		| "background"
		| "backgroundPanel"
		| "backgroundMenu"
		| "border"
		| "borderSubtle"
	> &
		Partial<Omit<ThemeColors, "agent">>;
};

const TEXT_BRIGHTNESS = 0.88;
const MUTED_TEXT_BRIGHTNESS = 0.58;
const THINKING_TEXT_BRIGHTNESS = 0.28;
const DISABLED_TEXT_BRIGHTNESS = 0.38;
const FILE_PATH_BRIGHTNESS = 0.35;
const HEX_COLOR_RE = /^#([\da-f]{3,4}|[\da-f]{6}(?:[\da-f]{2})?)$/iu;

const brightenColor = (color: string, amount: number) => {
	const match = color.match(HEX_COLOR_RE);
	if (!match) {
		return color;
	}

	const hex = match[1] ?? "";
	const expanded =
		hex.length <= 4
			? [...hex].map((value) => `${value}${value}`).join("")
			: hex;
	const channels = [
		Number.parseInt(expanded.slice(0, 2), 16),
		Number.parseInt(expanded.slice(2, 4), 16),
		Number.parseInt(expanded.slice(4, 6), 16),
	];

	return `#${channels
		.map((channel) =>
			Math.round(channel + (255 - channel) * amount)
				.toString(16)
				.padStart(2, "0")
		)
		.join("")}${expanded.slice(6)}`;
};

const THEME_DEFINITIONS = [
	{
		name: "aura",
		colors: {
			primary: "#a277ff",
			planMode: "#a277ff",
			selection: "#a277ff",
			thinking: "#a277ff",
			success: "#61ffca",
			error: "#ff6767",
			info: "#a277ff",
			text: "#edecee",
			textMuted: "#6d6d6d",
			background: "#0f0f0f",
			backgroundPanel: "#15141b",
			backgroundElement: "#15141b",
			backgroundMenu: "#15141b",
			border: "#2d2d2d",
			borderSubtle: "#2d2d2d",
			borderActive: "#6d6d6d",
		},
	},
	{
		name: "ayu",
		colors: {
			primary: "#59C2FF",
			planMode: "#E6B450",
			selection: "#59C2FF",
			thinking: "#E6B450",
			success: "#7FD962",
			error: "#D95757",
			info: "#39BAE6",
			text: "#BFBDB6",
			textMuted: "#565B66",
			background: "#0B0E14",
			backgroundPanel: "#0F131A",
			backgroundElement: "#0D1017",
			backgroundMenu: "#0D1017",
			border: "#6C7380",
			borderSubtle: "#11151C",
			borderActive: "#6C7380",
		},
	},
	{
		name: "carbonfox",
		colors: {
			primary: "#33b1ff",
			planMode: "#ff7eb6",
			selection: "#33b1ff",
			thinking: "#ff7eb6",
			success: "#25be6a",
			error: "#ee5396",
			info: "#78a9ff",
			text: "#f2f4f8",
			textMuted: "#7d848f",
			background: "#161616",
			backgroundPanel: "#1a1a1a",
			backgroundElement: "#1e1e1e",
			backgroundMenu: "#1e1e1e",
			border: "#303030",
			borderSubtle: "#262626",
			borderActive: "#33b1ff",
		},
	},
	{
		name: "catppuccin-frappe",
		colors: {
			primary: "#8da4e2",
			planMode: "#f4b8e4",
			selection: "#8da4e2",
			thinking: "#f4b8e4",
			success: "#a6d189",
			error: "#e78284",
			info: "#81c8be",
			text: "#c6d0f5",
			textMuted: "#949cb8",
			background: "#303446",
			backgroundPanel: "#292c3c",
			backgroundElement: "#232634",
			backgroundMenu: "#232634",
			border: "#414559",
			borderSubtle: "#626880",
			borderActive: "#51576d",
		},
	},
	{
		name: "catppuccin-macchiato",
		colors: {
			primary: "#8aadf4",
			planMode: "#f5bde6",
			selection: "#8aadf4",
			thinking: "#f5bde6",
			success: "#a6da95",
			error: "#ed8796",
			info: "#8bd5ca",
			text: "#cad3f5",
			textMuted: "#939ab7",
			background: "#24273a",
			backgroundPanel: "#1e2030",
			backgroundElement: "#181926",
			backgroundMenu: "#181926",
			border: "#363a4f",
			borderSubtle: "#5b6078",
			borderActive: "#494d64",
		},
	},
	{
		name: "catppuccin",
		colors: {
			primary: "#89b4fa",
			planMode: "#f5c2e7",
			selection: "#89b4fa",
			thinking: "#f5c2e7",
			success: "#a6e3a1",
			error: "#f38ba8",
			info: "#94e2d5",
			text: "#cdd6f4",
			textMuted: "#9399b2",
			background: "#1e1e2e",
			backgroundPanel: "#181825",
			backgroundElement: "#11111b",
			backgroundMenu: "#11111b",
			border: "#313244",
			borderSubtle: "#585b70",
			borderActive: "#45475a",
		},
	},
	{
		name: "cobalt2",
		colors: {
			primary: "#0088ff",
			planMode: "#2affdf",
			selection: "#0088ff",
			thinking: "#2affdf",
			success: "#9eff80",
			error: "#ff0088",
			info: "#ff9d00",
			text: "#ffffff",
			textMuted: "#adb7c9",
			background: "#193549",
			backgroundPanel: "#122738",
			backgroundElement: "#1f4662",
			backgroundMenu: "#1f4662",
			border: "#1f4662",
			borderSubtle: "#0e1e2e",
			borderActive: "#0088ff",
		},
	},
	{
		name: "cursor",
		colors: {
			primary: "#88c0d0",
			planMode: "#88c0d0",
			selection: "#88c0d0",
			thinking: "#88c0d0",
			success: "#3fa266",
			error: "#e34671",
			info: "#81a1c1",
			text: "#e4e4e4",
			textMuted: "#e4e4e45e",
			background: "#181818",
			backgroundPanel: "#141414",
			backgroundElement: "#262626",
			backgroundMenu: "#262626",
			border: "#e4e4e413",
			borderSubtle: "#0f0f0f",
			borderActive: "#88c0d0",
		},
	},
	{
		name: "dracula",
		colors: {
			primary: "#bd93f9",
			planMode: "#8be9fd",
			selection: "#bd93f9",
			thinking: "#8be9fd",
			success: "#50fa7b",
			error: "#ff5555",
			info: "#ffb86c",
			text: "#f8f8f2",
			textMuted: "#6272a4",
			background: "#282a36",
			backgroundPanel: "#21222c",
			backgroundElement: "#44475a",
			backgroundMenu: "#44475a",
			border: "#44475a",
			borderSubtle: "#191a21",
			borderActive: "#bd93f9",
		},
	},
	{
		name: "everforest",
		colors: {
			primary: "#a7c080",
			planMode: "#d699b6",
			selection: "#a7c080",
			thinking: "#d699b6",
			success: "#a7c080",
			error: "#e67e80",
			info: "#83c092",
			text: "#d3c6aa",
			textMuted: "#7a8478",
			background: "#2d353b",
			backgroundPanel: "#333c43",
			backgroundElement: "#343f44",
			backgroundMenu: "#343f44",
			border: "#859289",
			borderSubtle: "#7a8478",
			borderActive: "#9da9a0",
		},
	},
	{
		name: "flexoki",
		colors: {
			primary: "#DA702C",
			planMode: "#8B7EC8",
			selection: "#DA702C",
			thinking: "#8B7EC8",
			success: "#879A39",
			error: "#D14D41",
			info: "#3AA99F",
			text: "#CECDC3",
			textMuted: "#6F6E69",
			background: "#100F0F",
			backgroundPanel: "#1C1B1A",
			backgroundElement: "#282726",
			backgroundMenu: "#282726",
			border: "#575653",
			borderSubtle: "#403E3C",
			borderActive: "#6F6E69",
		},
	},
	{
		name: "github",
		colors: {
			primary: "#58a6ff",
			planMode: "#39c5cf",
			selection: "#58a6ff",
			thinking: "#39c5cf",
			success: "#3fb950",
			error: "#f85149",
			info: "#d29922",
			text: "#c9d1d9",
			textMuted: "#8b949e",
			background: "#0d1117",
			backgroundPanel: "#010409",
			backgroundElement: "#161b22",
			backgroundMenu: "#161b22",
			border: "#30363d",
			borderSubtle: "#21262d",
			borderActive: "#58a6ff",
		},
	},
	{
		name: "gruvbox",
		colors: {
			primary: "#83a598",
			planMode: "#8ec07c",
			selection: "#83a598",
			thinking: "#8ec07c",
			success: "#b8bb26",
			error: "#fb4934",
			info: "#fabd2f",
			text: "#ebdbb2",
			textMuted: "#928374",
			background: "#282828",
			backgroundPanel: "#3c3836",
			backgroundElement: "#504945",
			backgroundMenu: "#504945",
			border: "#665c54",
			borderSubtle: "#504945",
			borderActive: "#ebdbb2",
		},
	},
	{
		name: "kanagawa",
		colors: {
			primary: "#7E9CD8",
			planMode: "#D27E99",
			selection: "#7E9CD8",
			thinking: "#D27E99",
			success: "#98BB6C",
			error: "#E82424",
			info: "#76946A",
			text: "#DCD7BA",
			textMuted: "#727169",
			background: "#1F1F28",
			backgroundPanel: "#2A2A37",
			backgroundElement: "#363646",
			backgroundMenu: "#363646",
			border: "#54546D",
			borderSubtle: "#363646",
			borderActive: "#C38D9D",
		},
	},
	{
		name: "lucent-orng",
		colors: {
			primary: "#EC5B2B",
			planMode: "#FFF7F1",
			selection: "#EC5B2B",
			thinking: "#FFF7F1",
			success: "#6ba1e6",
			error: "#e06c75",
			info: "#56b6c2",
			text: "#eeeeee",
			textMuted: "#808080",
			background: "transparent",
			backgroundPanel: "transparent",
			backgroundElement: "transparent",
			backgroundMenu: "transparent",
			border: "#EC5B2B",
			borderSubtle: "#3c3c3c",
			borderActive: "#EE7948",
		},
	},
	{
		name: "material",
		colors: {
			primary: "#82aaff",
			planMode: "#89ddff",
			selection: "#82aaff",
			thinking: "#89ddff",
			success: "#c3e88d",
			error: "#f07178",
			info: "#ffcb6b",
			text: "#eeffff",
			textMuted: "#546e7a",
			background: "#263238",
			backgroundPanel: "#1e272c",
			backgroundElement: "#37474f",
			backgroundMenu: "#37474f",
			border: "#37474f",
			borderSubtle: "#1e272c",
			borderActive: "#82aaff",
		},
	},
	{
		name: "matrix",
		colors: {
			primary: "#2eff6a",
			planMode: "#c770ff",
			selection: "#2eff6a",
			thinking: "#c770ff",
			success: "#62ff94",
			error: "#ff4b4b",
			info: "#30b3ff",
			text: "#62ff94",
			textMuted: "#8ca391",
			background: "#0a0e0a",
			backgroundPanel: "#0e130d",
			backgroundElement: "#141c12",
			backgroundMenu: "#141c12",
			border: "#1e2a1b",
			borderSubtle: "#141c12",
			borderActive: "#2eff6a",
		},
	},
	{
		name: "mercury",
		colors: {
			primary: "#8da4f5",
			planMode: "#8da4f5",
			selection: "#8da4f5",
			thinking: "#8da4f5",
			success: "#77c599",
			error: "#fc92b4",
			info: "#77becf",
			text: "#dddde5",
			textMuted: "#9d9da8",
			background: "#171721",
			backgroundPanel: "#10101a",
			backgroundElement: "#272735",
			backgroundMenu: "#272735",
			border: "#b4b7c81f",
			borderSubtle: "#b4b7c814",
			borderActive: "#8da4f5",
		},
	},
	{
		name: "monokai",
		colors: {
			primary: "#66d9ef",
			planMode: "#a6e22e",
			selection: "#66d9ef",
			thinking: "#a6e22e",
			success: "#a6e22e",
			error: "#f92672",
			info: "#fd971f",
			text: "#f8f8f2",
			textMuted: "#75715e",
			background: "#272822",
			backgroundPanel: "#1e1f1c",
			backgroundElement: "#3e3d32",
			backgroundMenu: "#3e3d32",
			border: "#3e3d32",
			borderSubtle: "#1e1f1c",
			borderActive: "#66d9ef",
		},
	},
	{
		name: "nightowl",
		colors: {
			primary: "#82AAFF",
			planMode: "#c792ea",
			selection: "#82AAFF",
			thinking: "#c792ea",
			success: "#c5e478",
			error: "#EF5350",
			info: "#82AAFF",
			text: "#d6deeb",
			textMuted: "#5f7e97",
			background: "#011627",
			backgroundPanel: "#0b253a",
			backgroundElement: "#0b253a",
			backgroundMenu: "#0b253a",
			border: "#5f7e97",
			borderSubtle: "#5f7e97",
			borderActive: "#82AAFF",
		},
	},
	{
		name: "nord",
		colors: {
			primary: "#88C0D0",
			planMode: "#8FBCBB",
			selection: "#88C0D0",
			thinking: "#8FBCBB",
			success: "#A3BE8C",
			error: "#BF616A",
			info: "#88C0D0",
			text: "#ECEFF4",
			textMuted: "#8B95A7",
			background: "#2E3440",
			backgroundPanel: "#3B4252",
			backgroundElement: "#434C5E",
			backgroundMenu: "#434C5E",
			border: "#434C5E",
			borderSubtle: "#434C5E",
			borderActive: "#4C566A",
		},
	},
	{
		name: "one-dark",
		colors: {
			primary: "#61afef",
			planMode: "#56b6c2",
			selection: "#61afef",
			thinking: "#56b6c2",
			success: "#98c379",
			error: "#e06c75",
			info: "#d19a66",
			text: "#abb2bf",
			textMuted: "#5c6370",
			background: "#282c34",
			backgroundPanel: "#21252b",
			backgroundElement: "#353b45",
			backgroundMenu: "#353b45",
			border: "#393f4a",
			borderSubtle: "#2c313a",
			borderActive: "#61afef",
		},
	},
	{
		name: "opencode",
		colors: {
			primary: "#fab283",
			planMode: "#9d7cd8",
			selection: "#fab283",
			thinking: "#9d7cd8",
			success: "#7fd88f",
			error: "#e06c75",
			info: "#56b6c2",
			text: "#eeeeee",
			textMuted: "#808080",
			background: "#0a0a0a",
			backgroundPanel: "#141414",
			backgroundElement: "#1e1e1e",
			backgroundMenu: "#1e1e1e",
			border: "#484848",
			borderSubtle: "#3c3c3c",
			borderActive: "#606060",
		},
	},
	{
		name: "orng",
		colors: {
			primary: "#EC5B2B",
			planMode: "#FFF7F1",
			selection: "#EC5B2B",
			thinking: "#FFF7F1",
			success: "#6ba1e6",
			error: "#e06c75",
			info: "#56b6c2",
			text: "#eeeeee",
			textMuted: "#808080",
			background: "#0a0a0a",
			backgroundPanel: "#141414",
			backgroundElement: "#1e1e1e",
			backgroundMenu: "#1e1e1e",
			border: "#EC5B2B",
			borderSubtle: "#3c3c3c",
			borderActive: "#EE7948",
		},
	},
	{
		name: "osaka-jade",
		colors: {
			primary: "#2DD5B7",
			planMode: "#549e6a",
			selection: "#2DD5B7",
			thinking: "#549e6a",
			success: "#549e6a",
			error: "#FF5345",
			info: "#2DD5B7",
			text: "#C1C497",
			textMuted: "#53685B",
			background: "#111c18",
			backgroundPanel: "#1a2520",
			backgroundElement: "#23372B",
			backgroundMenu: "#23372B",
			border: "#3d4a44",
			borderSubtle: "#23372B",
			borderActive: "#2DD5B7",
		},
	},
	{
		name: "palenight",
		colors: {
			primary: "#82aaff",
			planMode: "#89ddff",
			selection: "#82aaff",
			thinking: "#89ddff",
			success: "#c3e88d",
			error: "#f07178",
			info: "#f78c6c",
			text: "#a6accd",
			textMuted: "#676e95",
			background: "#292d3e",
			backgroundPanel: "#1e2132",
			backgroundElement: "#32364a",
			backgroundMenu: "#32364a",
			border: "#32364a",
			borderSubtle: "#1e2132",
			borderActive: "#82aaff",
		},
	},
	{
		name: "rosepine",
		colors: {
			primary: "#9ccfd8",
			planMode: "#ebbcba",
			selection: "#9ccfd8",
			thinking: "#ebbcba",
			success: "#31748f",
			error: "#eb6f92",
			info: "#9ccfd8",
			text: "#e0def4",
			textMuted: "#6e6a86",
			background: "#191724",
			backgroundPanel: "#1f1d2e",
			backgroundElement: "#26233a",
			backgroundMenu: "#26233a",
			border: "#403d52",
			borderSubtle: "#21202e",
			borderActive: "#9ccfd8",
		},
	},
	{
		name: "solarized",
		colors: {
			primary: "#268bd2",
			planMode: "#2aa198",
			selection: "#268bd2",
			thinking: "#2aa198",
			success: "#859900",
			error: "#dc322f",
			info: "#cb4b16",
			text: "#839496",
			textMuted: "#586e75",
			background: "#002b36",
			backgroundPanel: "#073642",
			backgroundElement: "#073642",
			backgroundMenu: "#073642",
			border: "#073642",
			borderSubtle: "#073642",
			borderActive: "#586e75",
		},
	},
	{
		name: "synthwave84",
		colors: {
			primary: "#36f9f6",
			planMode: "#b084eb",
			selection: "#36f9f6",
			thinking: "#b084eb",
			success: "#72f1b8",
			error: "#fe4450",
			info: "#ff8b39",
			text: "#ffffff",
			textMuted: "#848bbd",
			background: "#262335",
			backgroundPanel: "#1e1a29",
			backgroundElement: "#2a2139",
			backgroundMenu: "#2a2139",
			border: "#495495",
			borderSubtle: "#241b2f",
			borderActive: "#36f9f6",
		},
	},
	{
		name: "tokyonight",
		colors: {
			primary: "#82aaff",
			planMode: "#ff966c",
			selection: "#82aaff",
			thinking: "#ff966c",
			success: "#c3e88d",
			error: "#ff757f",
			info: "#82aaff",
			text: "#c8d3f5",
			textMuted: "#828bb8",
			background: "#1a1b26",
			backgroundPanel: "#1e2030",
			backgroundElement: "#222436",
			backgroundMenu: "#222436",
			border: "#737aa2",
			borderSubtle: "#545c7e",
			borderActive: "#9099b2",
		},
	},
	{
		name: "vercel",
		colors: {
			primary: "#0070F3",
			planMode: "#8E4EC6",
			selection: "#0070F3",
			thinking: "#8E4EC6",
			success: "#46A758",
			error: "#E5484D",
			info: "#52A8FF",
			text: "#EDEDED",
			textMuted: "#878787",
			background: "#000000",
			backgroundPanel: "#1A1A1A",
			backgroundElement: "#292929",
			backgroundMenu: "#292929",
			border: "#1F1F1F",
			borderSubtle: "#1A1A1A",
			borderActive: "#454545",
		},
	},
	{
		name: "vesper",
		colors: {
			primary: "#FFC799",
			planMode: "#FFC799",
			selection: "#FFC799",
			thinking: "#FFC799",
			success: "#99FFE4",
			error: "#FF8080",
			info: "#FFC799",
			text: "#FFF",
			textMuted: "#A0A0A0",
			background: "#101010",
			backgroundPanel: "#101010",
			backgroundElement: "#101010",
			backgroundMenu: "#101010",
			border: "#282828",
			borderSubtle: "#1C1C1C",
			borderActive: "#FFC799",
		},
	},
	{
		name: "zenburn",
		colors: {
			primary: "#8cd0d3",
			planMode: "#93e0e3",
			selection: "#8cd0d3",
			thinking: "#93e0e3",
			success: "#7f9f7f",
			error: "#cc9393",
			info: "#dfaf8f",
			text: "#dcdccc",
			textMuted: "#9f9f9f",
			background: "#3f3f3f",
			backgroundPanel: "#4f4f4f",
			backgroundElement: "#5f5f5f",
			backgroundMenu: "#5f5f5f",
			border: "#5f5f5f",
			borderSubtle: "#4f4f4f",
			borderActive: "#8cd0d3",
		},
	},
] satisfies ThemeDefinition[];

export const resolveTheme = ({ colors, name }: ThemeDefinition): Theme => ({
	colors: {
		...colors,
		agent: { build: colors.primary, plan: colors.planMode },
		backgroundElement: colors.backgroundElement ?? colors.backgroundPanel,
		borderActive: colors.borderActive ?? colors.primary,
		fileBadgeBackground: colors.fileBadgeBackground ?? colors.primary,
		fileBadgeText:
			colors.fileBadgeText ??
			(colors.background === "transparent"
				? getContrastingTextColor(colors.primary)
				: colors.background),
		filePath:
			colors.filePath ??
			brightenColor(colors.borderSubtle, FILE_PATH_BRIGHTNESS),
		filePathBackground: colors.filePathBackground ?? colors.backgroundMenu,
		text:
			colors.text ??
			(colors.background === "transparent"
				? colors.primary
				: brightenColor(colors.background, TEXT_BRIGHTNESS)),
		textDisabled:
			colors.textDisabled ??
			(colors.background === "transparent"
				? colors.border
				: brightenColor(colors.background, DISABLED_TEXT_BRIGHTNESS)),
		textMuted:
			colors.textMuted ??
			(colors.background === "transparent"
				? colors.borderSubtle
				: brightenColor(colors.background, MUTED_TEXT_BRIGHTNESS)),
		thinkingText:
			colors.thinkingText ??
			brightenColor(
				colors.textMuted ??
					brightenColor(colors.background, MUTED_TEXT_BRIGHTNESS),
				THINKING_TEXT_BRIGHTNESS
			),
		tool:
			colors.tool ??
			colors.textMuted ??
			(colors.background === "transparent"
				? colors.borderSubtle
				: brightenColor(colors.background, MUTED_TEXT_BRIGHTNESS)),
	},
	name,
});

export const THEMES: Theme[] = THEME_DEFINITIONS.map(resolveTheme);

export const getAgentColor = (colors: ThemeColors, agent: string): string =>
	colors.agent[agent] ?? colors.primary;

export const OPENCODE_THEME_NAME = "opencode";
export function findThemeByName(
	themes: readonly Theme[],
	name: string
): Theme | undefined {
	return themes.find((theme) => theme.name === name);
}
const defaultTheme = findThemeByName(THEMES, OPENCODE_THEME_NAME);
if (!defaultTheme) {
	throw new Error(`Default theme not found: ${OPENCODE_THEME_NAME}`);
}
export const DEFAULT_THEME: Theme = defaultTheme;
