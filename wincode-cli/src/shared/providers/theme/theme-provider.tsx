import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import { z } from "zod";
import type { Theme, ThemeColors } from "./themes";
import { DEFAULT_THEME, findThemeByName, THEMES } from "./themes";

const CONFIG_DIR = join(homedir(), ".wincode");
const THEME_PREFERENCES_PATH = join(CONFIG_DIR, "preferences.json");

const themePreferenceSchema = z.object({ themeName: z.string().nonempty() });

export function parseThemePreference(raw: string): Theme {
	try {
		const result = themePreferenceSchema.safeParse(JSON.parse(raw));
		if (!result.success) {
			return DEFAULT_THEME;
		}
		return findThemeByName(THEMES, result.data.themeName) ?? DEFAULT_THEME;
	} catch {
		return DEFAULT_THEME;
	}
}

export function serializeThemePreference(theme: Pick<Theme, "name">): string {
	return JSON.stringify({ themeName: theme.name }, null, 2);
}

function getInitialTheme(): Theme {
	try {
		return parseThemePreference(readFileSync(THEME_PREFERENCES_PATH, "utf8"));
	} catch {
		return DEFAULT_THEME;
	}
}

function persistTheme(theme: Theme) {
	try {
		mkdirSync(CONFIG_DIR, { recursive: true });
		writeFileSync(
			THEME_PREFERENCES_PATH,
			serializeThemePreference(theme),
			"utf8"
		);
	} catch {
		// Ignore preference write failures so theme switching still works for this session.
	}
}

type ThemeContextValue = {
	colors: ThemeColors;
	currentTheme: Theme;
	setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
	const value = useContext(ThemeContext);
	if (!value) {
		throw new Error("useTheme must be used within a ThemeProvider");
	}
	return value;
}

type ThemeProviderProps = {
	children: ReactNode;
	/**
	 * Pins the theme instead of the persisted preference. Used by tests that
	 * assert colors, where the user's `preferences.json` must not leak into
	 * expectations; a changed prop re-pins on the next render.
	 */
	themeName?: string;
};

const resolveThemeValue = (themeName: string | undefined): Theme =>
	themeName === undefined
		? getInitialTheme()
		: (findThemeByName(THEMES, themeName) ?? DEFAULT_THEME);

export function ThemeProvider({ children, themeName }: ThemeProviderProps) {
	const [currentTheme, setCurrentTheme] = useState<Theme>(() =>
		resolveThemeValue(themeName)
	);

	useEffect(() => {
		if (themeName !== undefined) {
			setCurrentTheme(resolveThemeValue(themeName));
		}
	}, [themeName]);

	const setTheme = useCallback((theme: Theme) => {
		setCurrentTheme(theme);
		persistTheme(theme);
	}, []);

	return (
		<ThemeContext.Provider
			value={{ colors: currentTheme.colors, currentTheme, setTheme }}
		>
			{children}
		</ThemeContext.Provider>
	);
}
