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
	"markup.heading": { fg: colors.primary, bold: true },
	"markup.strong": { fg: colors.text, bold: true },
	"markup.italic": { fg: colors.text, italic: true },
	"markup.strikethrough": { fg: colors.textMuted },
	"markup.raw": { fg: colors.tool },
	"markup.link": { fg: colors.info },
	"markup.link.label": { fg: colors.info },
	"markup.link.url": { fg: colors.info, underline: true },
	"markup.quote": { fg: colors.textMuted, italic: true },
});

const markdownStyleCacheKey = (colors: ThemeColors): string =>
	[
		colors.text,
		colors.textDisabled,
		colors.textMuted,
		colors.primary,
		colors.tool,
		colors.info,
	].join("|");

let cachedMarkdownStyle: { key: string; style: SyntaxStyle } | null = null;

const resolveMarkdownSyntaxStyle = (colors: ThemeColors): SyntaxStyle => {
	const key = markdownStyleCacheKey(colors);
	if (cachedMarkdownStyle?.key === key) {
		return cachedMarkdownStyle.style;
	}
	cachedMarkdownStyle?.style.destroy();
	const style = SyntaxStyle.fromStyles(buildMarkdownStyles(colors));
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
