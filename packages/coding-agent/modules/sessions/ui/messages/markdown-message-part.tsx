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
 * Renders message content through OpenTUI Markdown after sanitizing terminal
 * controls. Thinking content keeps Markdown formatting while italicizing the
 * complete block; user and assistant content use the standard theme.
 */
export const MarkdownContent = memo(function MarkdownContent({
	text,
	variant = "standard",
}: {
	text: string;
	variant?: "standard" | "thinking";
}) {
	const { colors } = useTheme();
	const syntaxStyle = useMemo(
		() => resolveSyntaxStyle(colors, variant),
		[colors, variant]
	);
	const sanitized = useMemo(() => stripMarkdownControlCharacters(text), [text]);

	return (
		<markdown
			conceal
			content={sanitized}
			internalBlockMode="top-level"
			streaming
			syntaxStyle={syntaxStyle}
			treeSitterClient={getTreeSitterClientForTests()}
			width="100%"
		/>
	);
});

export const MarkdownMessagePart = memo(function MarkdownMessagePart({
	text,
	variant = "standard",
}: {
	text: string;
	variant?: "standard" | "thinking";
}) {
	const { colors } = useTheme();

	return (
		<box backgroundColor={colors.background} paddingX={3} width="100%">
			<MarkdownContent text={text} variant={variant} />
		</box>
	);
});
