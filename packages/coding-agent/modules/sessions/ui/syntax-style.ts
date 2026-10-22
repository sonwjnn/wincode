import {
	getTreeSitterClient,
	type NativeResourceOwner,
	type SimpleHighlight,
	type StyleDefinitionInput,
	SyntaxStyle,
	type TreeSitterClient,
} from "@opentui/core";
import type { ThemeColors } from "@/shared/providers/theme/themes";

export type SyntaxStyleVariant = "standard" | "thinking";

const buildSyntaxStyles = (
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

export type SyntaxStyleKey = SyntaxStyleVariant | "composer";

type CachedSyntaxStyles = {
	key: string;
	styles: Map<SyntaxStyleKey, SyntaxStyle>;
};

const cachedSyntaxStyles = new WeakMap<
	NativeResourceOwner,
	CachedSyntaxStyles
>();

const buildComposerSyntaxStyles = (
	colors: ThemeColors
): Record<string, StyleDefinitionInput> => ({
	attachment: { bg: colors.primary, bold: true, fg: colors.background },
	fileMention: { bold: true, fg: colors.primary },
	pastedText: { bg: colors.primary, bold: true, fg: colors.background },
});

const SYNTAX_STYLE_BUILDERS: Record<
	SyntaxStyleKey,
	(colors: ThemeColors) => Record<string, StyleDefinitionInput>
> = {
	standard: (colors) => buildSyntaxStyles(colors, "standard"),
	thinking: (colors) => buildSyntaxStyles(colors, "thinking"),
	composer: buildComposerSyntaxStyles,
};

const resolveCachedSyntaxStyle = (
	owner: NativeResourceOwner,
	colors: ThemeColors,
	key: SyntaxStyleKey
): SyntaxStyle => {
	const colorsKey = JSON.stringify(colors);
	let cached = cachedSyntaxStyles.get(owner);
	if (cached?.key !== colorsKey) {
		for (const style of cached?.styles.values() ?? []) {
			style.destroy();
		}
		cached = { key: colorsKey, styles: new Map() };
		cachedSyntaxStyles.set(owner, cached);
	}
	const existing = cached.styles.get(key);
	if (existing) {
		return existing;
	}
	const style = SyntaxStyle.fromStyles(
		SYNTAX_STYLE_BUILDERS[key](colors),
		owner
	);
	cached.styles.set(key, style);
	return style;
};

export const resolveSyntaxStyle = (
	owner: NativeResourceOwner,
	colors: ThemeColors,
	key: SyntaxStyleKey = "standard"
): SyntaxStyle => resolveCachedSyntaxStyle(owner, colors, key);

/**
 * Tree-sitter can report a bracketed label in a standalone strong line as a
 * link-label candidate. Normalize only that scope to strong text; normal inline
 * links do not match, and the Markdown source remains untouched.
 */
const STANDALONE_STRONG_BRACKETED_LABEL_PATTERN =
	/^\s*\*\*\[[^\]\n]+\]\*\*\s*$/;
const normalizedTreeSitterClients = new WeakMap<
	TreeSitterClient,
	TreeSitterClient
>();

const lineForHighlight = (
	content: string,
	start: number,
	end: number
): string => {
	const lineStart = content.lastIndexOf("\n", start - 1) + 1;
	const nextLineBreak = content.indexOf("\n", end);
	const lineEnd = nextLineBreak === -1 ? content.length : nextLineBreak;
	return content.slice(lineStart, lineEnd);
};

const normalizeStandaloneSectionLabelScopes = (
	content: string,
	highlights: SimpleHighlight[]
): SimpleHighlight[] =>
	highlights.map((highlight) => {
		const [start, end, scope, metadata] = highlight;
		if (
			(scope !== "markup.link.label" && scope !== "nospell") ||
			!STANDALONE_STRONG_BRACKETED_LABEL_PATTERN.test(
				lineForHighlight(content, start, end)
			)
		) {
			return highlight;
		}
		return [start, end, "markup.strong", metadata];
	});

const normalizeTreeSitterClient = (
	client: TreeSitterClient
): TreeSitterClient => {
	const cachedClient = normalizedTreeSitterClients.get(client);
	if (cachedClient) {
		return cachedClient;
	}

	const normalizedClient = new Proxy(client, {
		get(target, property) {
			if (property === "highlightOnce") {
				return async (content: string, filetype: string) => {
					const result = await target.highlightOnce(content, filetype);
					if (
						(filetype !== "markdown" && filetype !== "markdown_inline") ||
						!result.highlights
					) {
						return result;
					}
					return {
						...result,
						highlights: normalizeStandaloneSectionLabelScopes(
							content,
							result.highlights
						),
					};
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, property, value) {
			return Reflect.set(target, property, value, target);
		},
	});
	normalizedTreeSitterClients.set(client, normalizedClient);
	return normalizedClient;
};

let treeSitterClientOverride: TreeSitterClient | null = null;

export const setTreeSitterClientForTests = (
	client: TreeSitterClient | null
): TreeSitterClient | null => {
	const previous = treeSitterClientOverride;
	treeSitterClientOverride = client;
	return previous;
};

export const getRawTreeSitterClient = (): TreeSitterClient | undefined =>
	treeSitterClientOverride ?? undefined;

export const getMarkdownTreeSitterClient = (): TreeSitterClient =>
	normalizeTreeSitterClient(treeSitterClientOverride ?? getTreeSitterClient());
