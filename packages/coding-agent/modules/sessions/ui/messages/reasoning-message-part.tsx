import type { BoxRenderable } from "@wincode/tui/core";
import { useMemo, useRef } from "react";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { getMarkdownTreeSitterClient } from "../tree-sitter-client";
import { useSyntaxStyle } from "../use-syntax-style";
import {
	type MarkdownPresentationProps,
	stripMarkdownControlCharacters,
	useMarkdownTransformation,
	useMeasuredMarkdownWidth,
} from "./markdown-message-part";

export function ReasoningMessagePart({
	messageId,
	pluginRuntime,
	sessionId,
	streaming,
	text,
}: {
	messageId?: string;
	pluginRuntime?: PluginRuntime;
	sessionId?: string;
	streaming: boolean;
	text: string;
}) {
	const { colors } = useTheme();
	const messageType = "assistant-thinking";
	const widthRef = useRef<BoxRenderable>(null);
	const enabled =
		pluginRuntime?.hasMarkdownTransformers(messageType, sessionId) ?? false;
	const { availableWidth, onSizeChange } = useMeasuredMarkdownWidth(
		widthRef,
		enabled,
		1
	);
	const presentation: MarkdownPresentationProps = {
		isStreaming: streaming,
		messageId,
		messageType,
		pluginRuntime,
		sessionId,
		text,
	};
	const transformed = useMarkdownTransformation(presentation, availableWidth);
	const content = useMemo(
		() => stripMarkdownControlCharacters(transformed),
		[transformed]
	);
	const syntaxStyle = useSyntaxStyle("thinking");

	return (
		<box
			flexShrink={0}
			onSizeChange={onSizeChange}
			paddingLeft={1}
			ref={widthRef}
			width="100%"
		>
			<code
				conceal
				content={content}
				fg={colors.thinkingText}
				filetype="markdown"
				streaming={streaming}
				syntaxStyle={syntaxStyle}
				treeSitterClient={getMarkdownTreeSitterClient()}
				width="100%"
			/>
		</box>
	);
}
