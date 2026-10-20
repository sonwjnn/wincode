import { memo, useMemo } from "react";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import {
	getMarkdownTreeSitterClient,
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
export const stripMarkdownControlCharacters = (value: string): string =>
	Array.from(value, (character) =>
		isMarkdownSafeCharacter(character.charCodeAt(0)) ? character : " "
	).join("");

/**
 * OpenTUI retains stable top-level blocks while only the trailing block grows.
 * The upstream highlighter bounds pending work per block during streaming.
 */
export const MarkdownContent = memo(function MarkdownContent({
	text,
	streaming = true,
	variant = "standard",
}: {
	text: string;
	streaming?: boolean;
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
			streaming={streaming}
			syntaxStyle={syntaxStyle}
			treeSitterClient={getMarkdownTreeSitterClient()}
			width="100%"
		/>
	);
});

export const MarkdownMessagePart = memo(function MarkdownMessagePart({
	text,
	streaming = false,
	variant = "standard",
}: {
	text: string;
	streaming?: boolean;
	variant?: "standard" | "thinking";
}) {
	const { colors } = useTheme();
	const syntaxStyle = useMemo(
		() => resolveSyntaxStyle(colors, variant),
		[colors, variant]
	);
	const content = useMemo(() => {
		const sanitized = stripMarkdownControlCharacters(text);
		return variant === "thinking" ? sanitized : sanitized.trim();
	}, [text, variant]);

	if (!content) {
		return null;
	}

	return (
		<box flexShrink={0} paddingLeft={3}>
			<markdown
				bg={colors.background}
				conceal
				content={content}
				fg={variant === "thinking" ? colors.thinkingText : colors.text}
				internalBlockMode="top-level"
				streaming={streaming}
				syntaxStyle={syntaxStyle}
				tableOptions={{ style: "grid", cellPaddingX: 1 }}
				treeSitterClient={getMarkdownTreeSitterClient()}
			/>
		</box>
	);
});
