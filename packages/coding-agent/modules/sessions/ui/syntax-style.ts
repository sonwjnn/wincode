import type { StyleDefinitionInput } from "@opentui/core";
import type { ThemeColors } from "@/shared/providers/theme/themes";

export type SyntaxStyleVariant = "standard" | "thinking";

export const buildSyntaxStyles = (
	colors: ThemeColors,
	variant: SyntaxStyleVariant
): Record<string, StyleDefinitionInput> => {
	const isThinking = variant === "thinking";
	const markdownStyle = (
		color: string,
		extras: Omit<StyleDefinitionInput, "fg"> = {}
	): StyleDefinitionInput => ({
		fg: isThinking ? colors.thinkingText : color,
		...extras,
		...(isThinking ? { italic: true } : {}),
	});
	const codeStyle = (color: string): StyleDefinitionInput => ({
		fg: color,
		...(isThinking ? { italic: true } : {}),
	});
	return {
		default: markdownStyle(colors.text),
		conceal: markdownStyle(colors.textDisabled),
		"markup.heading": markdownStyle(colors.mdHeading, { bold: true }),
		"markup.strong": markdownStyle(colors.mdStrong, { bold: true }),
		"markup.italic": markdownStyle(colors.mdEmph, { italic: true }),
		"markup.strikethrough": markdownStyle(colors.textMuted),
		"markup.raw": markdownStyle(colors.mdCode),
		"markup.link": markdownStyle(colors.mdLink),
		"markup.link.label": markdownStyle(colors.mdLink),
		"markup.link.url": markdownStyle(colors.mdLinkUrl, {
			dim: true,
			underline: true,
		}),
		"markup.quote": markdownStyle(colors.mdQuote, { italic: true }),
		"markup.list": markdownStyle(colors.mdListBullet),
		comment: codeStyle(colors.syntaxComment),
		keyword: codeStyle(colors.syntaxKeyword),
		function: codeStyle(colors.syntaxFunction),
		variable: codeStyle(colors.syntaxVariable),
		string: codeStyle(colors.syntaxString),
		number: codeStyle(colors.syntaxNumber),
		type: codeStyle(colors.syntaxType),
		operator: codeStyle(colors.syntaxOperator),
		punctuation: codeStyle(colors.syntaxPunctuation),
		constant: codeStyle(colors.syntaxKeyword),
		constructor: codeStyle(colors.syntaxFunction),
	};
};

export type SyntaxStyleSet = SyntaxStyleVariant | "composer";
