import { useRenderer } from "@opentui/react";
import { useMemo } from "react";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { resolveSyntaxStyle, type SyntaxStyleKey } from "./syntax-style";

export function useSyntaxStyle(variant: SyntaxStyleKey = "standard") {
	const { colors } = useTheme();
	const renderer = useRenderer();
	return useMemo(
		() => resolveSyntaxStyle(renderer.nativeScene, colors, variant),
		[colors, renderer.nativeScene, variant]
	);
}
