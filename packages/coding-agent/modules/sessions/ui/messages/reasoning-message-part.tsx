import { useMemo } from "react";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { stripMarkdownControlCharacters } from "./markdown-message-part";
import {
	getMarkdownTreeSitterClient,
	resolveSyntaxStyle,
} from "./syntax-style";

export function ReasoningMessagePart({
	streaming,
	text,
}: {
	streaming: boolean;
	text: string;
}) {
	const { colors } = useTheme();
	const content = useMemo(() => stripMarkdownControlCharacters(text), [text]);
	const syntaxStyle = useMemo(
		() => resolveSyntaxStyle(colors, "thinking"),
		[colors]
	);

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
