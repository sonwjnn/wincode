import {
	type StyleDefinitionInput,
	SyntaxStyle,
	type TreeSitterClient,
} from "@opentui/core";
import { memo, useMemo } from "react";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { ThemeColors } from "@/shared/providers/theme/themes";

/** Printable output characters plus tab and newline (structure must survive). */
const isMarkdownSafeCharacter = (code: number): boolean =>
	code === 0x09 ||
	code === 0x0a ||
	(code >= 0x20 && (code < 0x7f || code > 0x9f));

/**
 * Replaces control characters with spaces, preserving tab and newline.
 * Unlike `stripControlCharacters` in display-sanitize (which also blanks
 * newlines for single-line tool rows), markdown keeps line structure intact:
 * C0 (0–31 except tab/newline), DEL (0x7f), and C1 (127–159, including the
 * CSI introducer 0x9b) are all neutralized so a hostile or corrupted text
 * part can never inject escape sequences into the parse.
 */
const stripMarkdownControlCharacters = (value: string): string =>
	Array.from(value, (character) =>
		isMarkdownSafeCharacter(character.charCodeAt(0)) ? character : " "
	).join("");

const buildMarkdownStyles = (
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
	// Tree-sitter scopes in fenced code blocks. Dotted captures (for example
	// `keyword.conditional` or `function.call`) fall back to these bases.
	comment: { fg: colors.syntaxComment },
	keyword: { fg: colors.syntaxKeyword },
	function: { fg: colors.syntaxFunction },
	variable: { fg: colors.syntaxVariable },
	string: { fg: colors.syntaxString },
	number: { fg: colors.syntaxNumber },
	type: { fg: colors.syntaxType },
	operator: { fg: colors.syntaxOperator },
	punctuation: { fg: colors.syntaxPunctuation },
	// Aliases so constants and constructors read with their VS Code Dark+
	// siblings instead of falling through to the default text color.
	constant: { fg: colors.syntaxKeyword },
	constructor: { fg: colors.syntaxFunction },
});

// The cache key is the serialized style map itself, so adding or removing a
// token can never silently leave the cached SyntaxStyle stale (the manual
// key list this replaced drifted from the map in review).
let cachedMarkdownStyle: { key: string; style: SyntaxStyle } | null = null;

const resolveMarkdownSyntaxStyle = (colors: ThemeColors): SyntaxStyle => {
	const styles = buildMarkdownStyles(colors);
	const key = JSON.stringify(styles);
	if (cachedMarkdownStyle?.key === key) {
		return cachedMarkdownStyle.style;
	}
	cachedMarkdownStyle?.style.destroy();
	const style = SyntaxStyle.fromStyles(styles);
	cachedMarkdownStyle = { key, style };
	return style;
};

/**
 * Test seam: swaps the tree-sitter client used by every rendered markdown
 * part. Production keeps `undefined` so OpenTUI resolves its shared client
 * (real syntax highlighting); tests inject a `MockTreeSitterClient` so block
 * rendering resolves deterministically without the worker.
 */
let markdownTreeSitterClientOverride: TreeSitterClient | null = null;

export const setMarkdownTreeSitterClientForTests = (
	client: TreeSitterClient | null
): TreeSitterClient | null => {
	markdownTreeSitterClientOverride = client;
	return client;
};

/**
 * Renders one assistant text part as mapped markdown: headings, emphasis,
 * inline code, fenced code blocks, tables, links and lists are laid out by
 * OpenTUI's `MarkdownRenderable` instead of surfacing raw syntax. Content is
 * stripped of control characters before parsing so hostile or corrupted
 * output can never inject layout or escape sequences into the token stream,
 * and the parsed output streams incrementally while `isStreaming` is set so
 * a growing text part never re-parses from scratch.
 */
export const MarkdownMessagePart = memo(function MarkdownMessagePart({
	text,
	isStreaming,
}: {
	text: string;
	isStreaming: boolean;
}) {
	const { colors } = useTheme();
	const syntaxStyle = useMemo(
		() => resolveMarkdownSyntaxStyle(colors),
		[colors]
	);
	const sanitized = useMemo(() => stripMarkdownControlCharacters(text), [text]);

	return (
		<box paddingX={3} width="100%">
			<markdown
				conceal
				content={sanitized}
				streaming={isStreaming}
				syntaxStyle={syntaxStyle}
				treeSitterClient={markdownTreeSitterClientOverride ?? undefined}
				width="100%"
			/>
		</box>
	);
});
