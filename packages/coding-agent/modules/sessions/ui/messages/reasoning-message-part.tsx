import { useMemo } from "react";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { getMarkdownTreeSitterClient } from "../tree-sitter-client";
import { useSyntaxStyle } from "../use-syntax-style";
import { stripMarkdownControlCharacters } from "./markdown-message-part";

export function ReasoningMessagePart({
	streaming,
	text,
}: {
	streaming: boolean;
	text: string;
}) {
	const { colors } = useTheme();
	const content = useMemo(() => stripMarkdownControlCharacters(text), [text]);
	const syntaxStyle = useSyntaxStyle("thinking");

	return (
		<box flexShrink={0} paddingLeft={1}>
			<code
				conceal
				content={content}
				fg={colors.thinkingText}
				filetype="markdown"
				streaming={streaming}
				syntaxStyle={syntaxStyle}
				treeSitterClient={getMarkdownTreeSitterClient()}
			/>
		</box>
	);
}
