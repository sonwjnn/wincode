import { useRenderer } from "@opentui/react";
import { useMemo } from "react";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import {
	resolveComposerSyntaxStyle,
	resolveSyntaxStyle,
	type SyntaxStyleKey,
} from "./syntax-style";

export function useSyntaxStyle(key: SyntaxStyleKey = "standard") {
	const { colors } = useTheme();
	const renderer = useRenderer();
	return useMemo(
		() =>
			key === "composer"
				? resolveComposerSyntaxStyle(renderer.nativeScene, colors)
				: resolveSyntaxStyle(renderer.nativeScene, colors, key),
		[colors, key, renderer.nativeScene]
	);
}
