import {
	type StyleDefinitionInput,
	SyntaxStyle,
	type TreeSitterClient,
} from "@opentui/core";
import type { ThemeColors } from "@/shared/providers/theme/themes";

const buildSyntaxStyles = (
	colors: ThemeColors
): Record<string, StyleDefinitionInput> => ({
	default: { fg: colors.text },
	conceal: { fg: colors.textDisabled },
	"markup.heading": { fg: colors.mdHeading, bold: true },
	"markup.strong": { fg: colors.mdStrong, bold: true },
	"markup.italic": { fg: colors.mdEmph, italic: true },
	"markup.strikethrough": { fg: colors.textMuted },
	"markup.raw": { fg: colors.mdCode },
	"markup.link": { fg: colors.mdLink },
	"markup.link.label": { fg: colors.mdLink },
	"markup.link.url": { fg: colors.mdLinkUrl, dim: true, underline: true },
	"markup.quote": { fg: colors.mdQuote, italic: true },
	"markup.list": { fg: colors.mdListBullet },
	comment: { fg: colors.syntaxComment },
	keyword: { fg: colors.syntaxKeyword },
	function: { fg: colors.syntaxFunction },
	variable: { fg: colors.syntaxVariable },
	string: { fg: colors.syntaxString },
	number: { fg: colors.syntaxNumber },
	type: { fg: colors.syntaxType },
	operator: { fg: colors.syntaxOperator },
	punctuation: { fg: colors.syntaxPunctuation },
	constant: { fg: colors.syntaxKeyword },
	constructor: { fg: colors.syntaxFunction },
});

let cachedSyntaxStyle: { key: string; style: SyntaxStyle } | null = null;

export const resolveSyntaxStyle = (colors: ThemeColors): SyntaxStyle => {
	const styles = buildSyntaxStyles(colors);
	const key = JSON.stringify(styles);
	if (cachedSyntaxStyle?.key === key) {
		return cachedSyntaxStyle.style;
	}
	cachedSyntaxStyle?.style.destroy();
	const style = SyntaxStyle.fromStyles(styles);
	cachedSyntaxStyle = { key, style };
	return style;
};

let treeSitterClientOverride: TreeSitterClient | null = null;

export const setTreeSitterClientForTests = (
	client: TreeSitterClient | null
): TreeSitterClient | null => {
	const previous = treeSitterClientOverride;
	treeSitterClientOverride = client;
	return previous;
};

export const getTreeSitterClientForTests = (): TreeSitterClient | undefined =>
	treeSitterClientOverride ?? undefined;
