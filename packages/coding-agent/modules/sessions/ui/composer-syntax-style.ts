import type { StyleDefinitionInput } from "@opentui/core";
import type { ThemeColors } from "@/shared/providers/theme/themes";

const badgeStyle = (colors: ThemeColors): StyleDefinitionInput => ({
	bg: colors.primary,
	bold: true,
	fg: colors.background,
});

export const buildComposerSyntaxStyles = (
	colors: ThemeColors
): Record<string, StyleDefinitionInput> => ({
	attachment: badgeStyle(colors),
	fileMention: { bold: true, fg: colors.primary },
	pastedText: badgeStyle(colors),
});
