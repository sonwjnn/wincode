import { useRenderer } from "@opentui/react";
import { useMemo } from "react";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { resolveSyntaxStyle, type SyntaxStyleKey } from "./syntax-style";

export function useSyntaxStyle(key: SyntaxStyleKey = "standard") {
	const { colors } = useTheme();
	const renderer = useRenderer();
	return useMemo(
		() => resolveSyntaxStyle(renderer.nativeScene, colors, key),
		[colors, key, renderer.nativeScene]
	);
}
