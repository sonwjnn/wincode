import type { ModeType } from "@wincode/ai";

export type ThemeColors = {
	primary: string;
	planMode: string;
	mode: Record<ModeType, string>;
	selection: string;
	thinking: string;
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
		Partial<Omit<ThemeColors, "mode">>;
};

const TEXT_BRIGHTNESS = 0.88;
const MUTED_TEXT_BRIGHTNESS = 0.58;
const DISABLED_TEXT_BRIGHTNESS = 0.38;
const FILE_PATH_BRIGHTNESS = 0.35;

const brightenColor = (color: string, amount: number) => {
	const channels = [
		Number.parseInt(color.slice(1, 3), 16),
		Number.parseInt(color.slice(3, 5), 16),
		Number.parseInt(color.slice(5, 7), 16),
	];

	return `#${channels
		.map((channel) =>
			Math.round(channel + (255 - channel) * amount)
				.toString(16)
				.padStart(2, "0")
		)
		.join("")}`;
};

const THEME_DEFINITIONS = [
	{
		name: "Sonvox",
		colors: {
			primary: "#56D6C2",
			planMode: "#CF8EF4",
			selection: "#89B4FA",
			thinking: "#CF8EF4",
			success: "#82E0AA",
			error: "#E74C5E",
			info: "#56D6C2",
			background: "#0D0D12",
			backgroundPanel: "#1A1A24",
			backgroundMenu: "#0A0A10",
			border: "#34344A",
			borderSubtle: "#4E4E66",
		},
	},
	{
		name: "Catppuccin Mocha",
		colors: {
			primary: "#E0AF68",
			planMode: "#9D7CD8",
			selection: "#B4A4E8",
			thinking: "#9D7CD8",
			success: "#73DACA",
			error: "#F7768E",
			info: "#7AA2F7",
			background: "#11111B",
			backgroundPanel: "#1E1E2E",
			backgroundMenu: "#13131D",
			border: "#45475A",
			borderSubtle: "#585B70",
		},
	},
	{
		name: "Dracula",
		colors: {
			primary: "#BD93F9",
			planMode: "#FF79C6",
			selection: "#6272A4",
			thinking: "#FF79C6",
			success: "#50FA7B",
			error: "#FF5555",
			info: "#8BE9FD",
			background: "#282A36",
			backgroundPanel: "#343746",
			backgroundMenu: "#21222C",
			border: "#6272A4",
			borderSubtle: "#44475A",
		},
	},
	{
		name: "Monokai Pro",
		colors: {
			primary: "#FFD866",
			planMode: "#AB9DF2",
			selection: "#AB9DF2",
			thinking: "#AB9DF2",
			success: "#A9DC76",
			error: "#FF6188",
			info: "#78DCE8",
			background: "#2D2A2E",
			backgroundPanel: "#403E41",
			backgroundMenu: "#221F22",
			border: "#5B595C",
			borderSubtle: "#727072",
		},
	},
	{
		name: "Tokyo Night",
		colors: {
			primary: "#7AA2F7",
			planMode: "#BB9AF7",
			selection: "#7AA2F7",
			thinking: "#BB9AF7",
			success: "#9ECE6A",
			error: "#F7768E",
			info: "#7DCFFF",
			background: "#1A1B26",
			backgroundPanel: "#1E2030",
			backgroundMenu: "#16161E",
			border: "#3B4261",
			borderSubtle: "#565F89",
		},
	},
	{
		name: "Nord",
		colors: {
			primary: "#EBCB8B",
			planMode: "#B48EAD",
			selection: "#81A1C1",
			thinking: "#B48EAD",
			success: "#A3BE8C",
			error: "#BF616A",
			info: "#88C0D0",
			background: "#2E3440",
			backgroundPanel: "#3B4252",
			backgroundMenu: "#272C36",
			border: "#4C566A",
			borderSubtle: "#616E88",
		},
	},
	{
		name: "Synthwave",
		colors: {
			primary: "#F472B6",
			planMode: "#A855F7",
			selection: "#E879F9",
			thinking: "#A855F7",
			success: "#4ADE80",
			error: "#EF4444",
			info: "#C084FC",
			background: "#0A0A0A",
			backgroundPanel: "#171717",
			backgroundMenu: "#0D0D0D",
			border: "#404040",
			borderSubtle: "#525252",
		},
	},
	{
		name: "Midnight Sky",
		colors: {
			primary: "#6AAEF5",
			planMode: "#B07AE8",
			selection: "#8CC4F0",
			thinking: "#B07AE8",
			success: "#58CEA0",
			error: "#E8555A",
			info: "#7DCFFF",
			background: "#0A0E14",
			backgroundPanel: "#141A22",
			backgroundMenu: "#0E1319",
			border: "#4A5A6E",
			borderSubtle: "#607080",
		},
	},
	{
		name: "Neon Nights",
		colors: {
			primary: "#E86ACA",
			planMode: "#5ED4E8",
			selection: "#D48EE0",
			thinking: "#5ED4E8",
			success: "#4ED89C",
			error: "#F04858",
			info: "#E86ACA",
			background: "#0C0814",
			backgroundPanel: "#18122A",
			backgroundMenu: "#110C1E",
			border: "#5C4878",
			borderSubtle: "#745E90",
		},
	},
	{
		name: "Hacker Terminal",
		colors: {
			primary: "#00E5A0",
			planMode: "#D946EF",
			selection: "#2DD4BF",
			thinking: "#D946EF",
			success: "#4ADE80",
			error: "#F43F5E",
			info: "#06B6D4",
			background: "#050505",
			backgroundPanel: "#131313",
			backgroundMenu: "#0A0A0A",
			border: "#2E2E2E",
			borderSubtle: "#454545",
		},
	},
	{
		name: "One Dark",
		colors: {
			primary: "#CBAACB",
			planMode: "#55B6C2",
			selection: "#98C379",
			thinking: "#55B6C2",
			success: "#98C379",
			error: "#E06C75",
			info: "#61AFEF",
			background: "#1E2127",
			backgroundPanel: "#282C34",
			backgroundMenu: "#191C21",
			border: "#3E4451",
			borderSubtle: "#5C6370",
		},
	},
	{
		name: "Xcode Midnight",
		colors: {
			primary: "#FF7AB2",
			planMode: "#6BDFFF",
			selection: "#ACF2E4",
			thinking: "#6BDFFF",
			success: "#83C9BC",
			error: "#FF6961",
			info: "#B281EB",
			background: "#1F1F24",
			backgroundPanel: "#2A2A30",
			backgroundMenu: "#18181D",
			border: "#3E3E45",
			borderSubtle: "#57575F",
		},
	},
	{
		name: "Catppuccin Frappe",
		colors: {
			primary: "#8CAAEE",
			planMode: "#CA9EE6",
			selection: "#A6D189",
			thinking: "#CA9EE6",
			success: "#A6D189",
			error: "#E78284",
			info: "#85C1DC",
			background: "#232634",
			backgroundPanel: "#303446",
			backgroundMenu: "#1E2030",
			border: "#51576D",
			borderSubtle: "#626880",
		},
	},
	{
		name: "Vercel Dark",
		colors: {
			primary: "#8B5CF6",
			planMode: "#EC4899",
			selection: "#6366F1",
			thinking: "#EC4899",
			success: "#10B981",
			error: "#EF4444",
			info: "#3B82F6",
			background: "#030712",
			backgroundPanel: "#111827",
			backgroundMenu: "#060C18",
			border: "#1F2937",
			borderSubtle: "#374151",
		},
	},
	{
		name: "Material Ocean",
		colors: {
			primary: "#82AAFF",
			planMode: "#C792EA",
			selection: "#717CB4",
			thinking: "#C792EA",
			success: "#C3E88D",
			error: "#FF5370",
			info: "#89DDFF",
			background: "#0F111A",
			backgroundPanel: "#1A1C2A",
			backgroundMenu: "#090B16",
			border: "#3B3F5C",
			borderSubtle: "#4B5178",
		},
	},
	{
		name: "Dusk",
		colors: {
			primary: "#C9A0DC",
			planMode: "#F2B866",
			selection: "#E8889A",
			thinking: "#F2B866",
			success: "#7ED4A6",
			error: "#E25A6E",
			info: "#C9A0DC",
			background: "#110D16",
			backgroundPanel: "#1E1726",
			backgroundMenu: "#15101C",
			border: "#6B5880",
			borderSubtle: "#7E6E94",
		},
	},
	{
		name: "Ocean",
		colors: {
			primary: "#3B9ECF",
			planMode: "#E0A846",
			selection: "#6CC9A1",
			thinking: "#E0A846",
			success: "#A8D45F",
			error: "#D94F4F",
			info: "#3B9ECF",
			background: "#0B1218",
			backgroundPanel: "#152028",
			backgroundMenu: "#0F181F",
			border: "#4A6A7A",
			borderSubtle: "#5E7888",
		},
	},
	{
		name: "Soft Midnight",
		colors: {
			primary: "#60A5FA",
			planMode: "#F9A8D4",
			selection: "#93C5FD",
			thinking: "#F9A8D4",
			success: "#6EE7B7",
			error: "#FCA5A5",
			info: "#67E8F9",
			background: "#0F172A",
			backgroundPanel: "#1E293B",
			backgroundMenu: "#0C1322",
			border: "#334155",
			borderSubtle: "#475569",
		},
	},
	{
		name: "Minimal Dark",
		colors: {
			primary: "#A78BFA",
			planMode: "#38BDF8",
			selection: "#818CF8",
			thinking: "#38BDF8",
			success: "#34D399",
			error: "#FB7185",
			info: "#22D3EE",
			background: "#09090B",
			backgroundPanel: "#18181B",
			backgroundMenu: "#0C0C0F",
			border: "#3F3F46",
			borderSubtle: "#52525B",
		},
	},
	{
		name: "Solarized Dark",
		colors: {
			primary: "#268BD2",
			planMode: "#6C71C4",
			selection: "#6BC0CC",
			thinking: "#6C71C4",
			success: "#859900",
			error: "#DC322F",
			info: "#2AA198",
			background: "#002B36",
			backgroundPanel: "#073642",
			backgroundMenu: "#00212B",
			border: "#586E75",
			borderSubtle: "#657B83",
		},
	},
	{
		name: "Gruvbox Dark",
		colors: {
			primary: "#FABD2F",
			planMode: "#D3869B",
			selection: "#FABD2F",
			thinking: "#D3869B",
			success: "#B8BB26",
			error: "#FB4934",
			info: "#83A598",
			background: "#282828",
			backgroundPanel: "#3C3836",
			backgroundMenu: "#1D2021",
			border: "#504945",
			borderSubtle: "#665C54",
		},
	},
	{
		name: "Rosé Pine",
		colors: {
			primary: "#EBBCBA",
			planMode: "#C4A7E7",
			selection: "#C4A7E7",
			thinking: "#C4A7E7",
			success: "#31748F",
			error: "#EB6F92",
			info: "#9CCFD8",
			background: "#191724",
			backgroundPanel: "#1F1D2E",
			backgroundMenu: "#16141F",
			border: "#26233A",
			borderSubtle: "#524F67",
		},
	},
	{
		name: "Rosé Pine Moon",
		colors: {
			primary: "#EA9A97",
			planMode: "#C4A7E7",
			selection: "#EA9A97",
			thinking: "#C4A7E7",
			success: "#3E8FB0",
			error: "#EB6F92",
			info: "#9CCFD8",
			background: "#232136",
			backgroundPanel: "#2A273F",
			backgroundMenu: "#1E1C31",
			border: "#393552",
			borderSubtle: "#56526E",
		},
	},
	{
		name: "Kanagawa",
		colors: {
			primary: "#DCD7BA",
			planMode: "#957FB8",
			selection: "#7E9CD8",
			thinking: "#957FB8",
			success: "#76946A",
			error: "#C34043",
			info: "#7E9CD8",
			background: "#1F1F28",
			backgroundPanel: "#2A2A37",
			backgroundMenu: "#16161D",
			border: "#54546D",
			borderSubtle: "#727169",
		},
	},
	{
		name: "Everforest Dark",
		colors: {
			primary: "#A7C080",
			planMode: "#D699B6",
			selection: "#A7C080",
			thinking: "#D699B6",
			success: "#83C092",
			error: "#E67E80",
			info: "#7FBBB3",
			background: "#2D353B",
			backgroundPanel: "#343F44",
			backgroundMenu: "#272E33",
			border: "#4F585E",
			borderSubtle: "#859289",
		},
	},
	{
		name: "Ayu Dark",
		colors: {
			primary: "#E6B450",
			planMode: "#D2A6FF",
			selection: "#73B8FF",
			thinking: "#D2A6FF",
			success: "#7FD962",
			error: "#D95757",
			info: "#59C2FF",
			background: "#0B0E14",
			backgroundPanel: "#11151C",
			backgroundMenu: "#080A0F",
			border: "#2D3640",
			borderSubtle: "#475266",
		},
	},
	{
		name: "GitHub Dark",
		colors: {
			primary: "#79C0FF",
			planMode: "#D2A8FF",
			selection: "#79C0FF",
			thinking: "#D2A8FF",
			success: "#56D364",
			error: "#F85149",
			info: "#58A6FF",
			background: "#0D1117",
			backgroundPanel: "#161B22",
			backgroundMenu: "#090D13",
			border: "#30363D",
			borderSubtle: "#484F58",
		},
	},
	{
		name: "Palenight",
		colors: {
			primary: "#82AAFF",
			planMode: "#C792EA",
			selection: "#82AAFF",
			thinking: "#C792EA",
			success: "#C3E88D",
			error: "#FF5370",
			info: "#89DDFF",
			background: "#292D3E",
			backgroundPanel: "#343850",
			backgroundMenu: "#232738",
			border: "#4E5272",
			borderSubtle: "#676E95",
		},
	},
	{
		name: "Vesper",
		colors: {
			primary: "#FFC799",
			planMode: "#A78BFA",
			selection: "#FFC799",
			thinking: "#A78BFA",
			success: "#6EE7B7",
			error: "#EF4444",
			info: "#FFC799",
			background: "#101010",
			backgroundPanel: "#1C1C1C",
			backgroundMenu: "#0C0C0C",
			border: "#333333",
			borderSubtle: "#505050",
		},
	},
	{
		name: "Poimandres",
		colors: {
			primary: "#ADD7FF",
			planMode: "#A6ACCD",
			selection: "#ADD7FF",
			thinking: "#A6ACCD",
			success: "#5DE4C7",
			error: "#D0679D",
			info: "#89DDFF",
			background: "#1B1E28",
			backgroundPanel: "#252B37",
			backgroundMenu: "#161922",
			border: "#3B4058",
			borderSubtle: "#506477",
		},
	},
	{
		name: "Moonlight",
		colors: {
			primary: "#82AAFF",
			planMode: "#C099FF",
			selection: "#C099FF",
			thinking: "#C099FF",
			success: "#C3E88D",
			error: "#FF757F",
			info: "#77E0C6",
			background: "#1E2030",
			backgroundPanel: "#2B2F44",
			backgroundMenu: "#191B28",
			border: "#3E4265",
			borderSubtle: "#5B5E7A",
		},
	},
	{
		name: "Vitesse Dark",
		colors: {
			primary: "#4FC1FF",
			planMode: "#C186E0",
			selection: "#4FC1FF",
			thinking: "#C186E0",
			success: "#80C97F",
			error: "#E45649",
			info: "#4FC1FF",
			background: "#121212",
			backgroundPanel: "#1E1E1E",
			backgroundMenu: "#0E0E0E",
			border: "#333333",
			borderSubtle: "#555555",
		},
	},
] satisfies ThemeDefinition[];

export const resolveTheme = ({ colors, name }: ThemeDefinition): Theme => ({
	colors: {
		...colors,
		backgroundElement: colors.backgroundElement ?? colors.backgroundPanel,
		borderActive: colors.borderActive ?? colors.primary,
		fileBadgeBackground: colors.fileBadgeBackground ?? colors.primary,
		fileBadgeText: colors.fileBadgeText ?? colors.background,
		filePath:
			colors.filePath ??
			brightenColor(colors.borderSubtle, FILE_PATH_BRIGHTNESS),
		filePathBackground: colors.filePathBackground ?? colors.backgroundMenu,
		mode: { build: colors.primary, plan: colors.planMode },
		text: colors.text ?? brightenColor(colors.background, TEXT_BRIGHTNESS),
		textDisabled:
			colors.textDisabled ??
			brightenColor(colors.background, DISABLED_TEXT_BRIGHTNESS),
		textMuted:
			colors.textMuted ??
			brightenColor(colors.background, MUTED_TEXT_BRIGHTNESS),
	},
	name,
});

export const THEMES: Theme[] = THEME_DEFINITIONS.map(resolveTheme);

export const SONVOX_THEME_NAME = "Sonvox";
export function getDefaultTheme(themes: readonly Theme[]): Theme {
	const defaultTheme = themes.find((theme) => theme.name === SONVOX_THEME_NAME);
	if (!defaultTheme) {
		throw new Error(`Default theme not found: ${SONVOX_THEME_NAME}`);
	}
	return defaultTheme;
}
export const DEFAULT_THEME: Theme = getDefaultTheme(THEMES);
