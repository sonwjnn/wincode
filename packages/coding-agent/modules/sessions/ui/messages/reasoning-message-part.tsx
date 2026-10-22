import { useMemo } from "react";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { stripMarkdownControlCharacters } from "./markdown-message-part";
import { getMarkdownTreeSitterClient } from "./syntax-style";
import { useSyntaxStyle } from "./use-syntax-style";

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
