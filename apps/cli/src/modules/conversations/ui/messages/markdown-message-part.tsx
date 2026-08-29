import { memo, useMemo } from "react";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import {
	getTreeSitterClientForTests,
	resolveSyntaxStyle,
	setTreeSitterClientForTests,
} from "./syntax-style";

export const setMarkdownTreeSitterClientForTests = setTreeSitterClientForTests;

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

/**
 * Renders one assistant text part as mapped markdown: headings, emphasis,
 * inline code, fenced code blocks, tables, links and lists are laid out by
 * OpenTUI's `MarkdownRenderable` instead of surfacing raw syntax. Control
 * characters are stripped so output cannot inject layout or escape sequences.
 * Streaming uses top-level block mode: completed blocks are frozen while only
 * the unfinished tail is reparsed. This prevents settled headings and lists
 * from alternating between raw and concealed frames on later token updates.
 */
export const MarkdownMessagePart = memo(function MarkdownMessagePart({
	text,
}: {
	text: string;
}) {
	const { colors } = useTheme();
	const syntaxStyle = useMemo(() => resolveSyntaxStyle(colors), [colors]);
	const sanitized = useMemo(() => stripMarkdownControlCharacters(text), [text]);

	return (
		<box backgroundColor={colors.background} paddingX={3} width="100%">
			<markdown
				conceal
				content={sanitized}
				internalBlockMode="top-level"
				streaming
				syntaxStyle={syntaxStyle}
				treeSitterClient={getTreeSitterClientForTests()}
				width="100%"
			/>
		</box>
	);
});
