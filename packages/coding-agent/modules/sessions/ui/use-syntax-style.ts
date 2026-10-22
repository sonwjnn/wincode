import {
	type NativeResourceOwner,
	type StyleDefinitionInput,
	SyntaxStyle,
} from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useMemo } from "react";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { ThemeColors } from "@/shared/providers/theme/themes";
import { buildComposerSyntaxStyles } from "./composer-syntax-style";
import { buildSyntaxStyles, type SyntaxStyleSet } from "./syntax-style";

const SYNTAX_STYLE_BUILDERS: Record<
	SyntaxStyleSet,
	(colors: ThemeColors) => Record<string, StyleDefinitionInput>
> = {
	standard: (colors) => buildSyntaxStyles(colors, "standard"),
	thinking: (colors) => buildSyntaxStyles(colors, "thinking"),
	composer: buildComposerSyntaxStyles,
};

type CachedSyntaxStyles = {
	key: string;
	styles: Map<SyntaxStyleSet, SyntaxStyle>;
};

const cachedSyntaxStyles = new WeakMap<
	NativeResourceOwner,
	CachedSyntaxStyles
>();

export function useSyntaxStyle(styleSet: SyntaxStyleSet = "standard") {
	const { colors } = useTheme();
	const renderer = useRenderer();
	return useMemo(() => {
		const owner = renderer.nativeScene;
		const colorsKey = JSON.stringify(colors);
		let cached = cachedSyntaxStyles.get(owner);
		if (cached?.key !== colorsKey) {
			for (const style of cached?.styles.values() ?? []) {
				style.destroy();
			}
			cached = { key: colorsKey, styles: new Map() };
			cachedSyntaxStyles.set(owner, cached);
		}
		const existing = cached.styles.get(styleSet);
		if (existing) {
			return existing;
		}
		const style = SyntaxStyle.fromStyles(
			SYNTAX_STYLE_BUILDERS[styleSet](colors),
			owner
		);
		cached.styles.set(styleSet, style);
		return style;
	}, [colors, renderer.nativeScene, styleSet]);
}
