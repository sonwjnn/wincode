import { useRenderer } from "@opentui/react";
import { useMemo } from "react";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import {
	resolveComposerSyntaxStyle,
	resolveSyntaxStyle,
	type SyntaxStyleVariant,
} from "./syntax-style";

export function useSyntaxStyle(variant: SyntaxStyleVariant = "standard") {
	const { colors } = useTheme();
	const renderer = useRenderer();
	return useMemo(
		() => resolveSyntaxStyle(renderer.nativeScene, colors, variant),
		[colors, renderer.nativeScene, variant]
	);
}

export function useComposerSyntaxStyle() {
	const { colors } = useTheme();
	const renderer = useRenderer();
	return useMemo(
		() => resolveComposerSyntaxStyle(renderer.nativeScene, colors),
		[colors, renderer.nativeScene]
	);
}
