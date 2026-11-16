import type { ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";

export type TuiThemeColor = string | Readonly<Record<string, string>>;
export type TuiThemeColors = Readonly<
	Record<string, TuiThemeColor> &
		Record<"error" | "info" | "success" | "warning", string>
>;
export type TuiTheme = Readonly<{
	colors: TuiThemeColors;
}>;

export type LocalStyleColors = Readonly<Record<string, string>>;

type ThemeProviderProps = Readonly<{
	children: ReactNode;
	theme: TuiTheme;
}>;

type LocalStyleProviderProps = Readonly<{
	children: ReactNode;
	colors: LocalStyleColors;
}>;

type ThemeContextValue = Readonly<{
	colors: TuiThemeColors;
	theme: TuiTheme;
}>;

const ThemeContext = createContext<TuiTheme | null>(null);
const LocalStyleContext = createContext<LocalStyleColors>({});

export function ThemeProvider({ children, theme }: ThemeProviderProps) {
	return (
		<ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
	);
}

/** Applies color-token overrides to this React subtree without changing its theme. */
export function LocalStyleProvider({
	children,
	colors,
}: LocalStyleProviderProps) {
	const parentColors = useContext(LocalStyleContext);
	const localColors = useMemo(
		() => ({ ...parentColors, ...colors }),
		[parentColors, colors]
	);
	return (
		<LocalStyleContext.Provider value={localColors}>
			{children}
		</LocalStyleContext.Provider>
	);
}

export function useTheme(): ThemeContextValue {
	const theme = useContext(ThemeContext);
	const localColors = useContext(LocalStyleContext);
	if (!theme) {
		throw new Error("useTheme must be used within a ThemeProvider");
	}
	return { colors: { ...theme.colors, ...localColors }, theme };
}
