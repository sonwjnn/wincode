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
	const syntaxStyle = useMemo(() => resolveSyntaxStyle(colors), [colors]);
	const sanitized = useMemo(() => stripMarkdownControlCharacters(text), [text]);

	return (
		<box paddingX={3} width="100%">
			<markdown
				conceal
				content={sanitized}
				streaming={isStreaming}
				syntaxStyle={syntaxStyle}
				treeSitterClient={getTreeSitterClientForTests()}
				width="100%"
			/>
		</box>
	);
});
