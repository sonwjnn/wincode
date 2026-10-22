import { type StyleDefinitionInput, SyntaxStyle } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useMemo } from "react";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { ThemeColors } from "@/shared/providers/theme/themes";
import { buildComposerSyntaxStyles } from "./composer-syntax-style";
import {
	buildSyntaxStyles,
	resolveSyntaxStyle,
	type SyntaxStyleSet,
} from "./syntax-style";

const SYNTAX_STYLE_BUILDERS: Record<
	SyntaxStyleSet,
	(colors: ThemeColors) => Record<string, StyleDefinitionInput>
> = {
	standard: (colors) => buildSyntaxStyles(colors, "standard"),
	thinking: (colors) => buildSyntaxStyles(colors, "thinking"),
	composer: buildComposerSyntaxStyles,
};

export function useSyntaxStyle(styleSet: SyntaxStyleSet = "standard") {
	const { colors } = useTheme();
	const renderer = useRenderer();
	return useMemo(
		() =>
			resolveSyntaxStyle(renderer.nativeScene, colors, styleSet, () =>
				SyntaxStyle.fromStyles(
					SYNTAX_STYLE_BUILDERS[styleSet](colors),
					renderer.nativeScene
				)
			),
		[colors, renderer.nativeScene, styleSet]
	);
}
