import type { BoxRenderable, Renderable } from "@wincode/tui/core";
import {
	memo,
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { PluginMarkdownMessageType } from "@/modules/plugins/public";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import { usePluginRendererRevision } from "@/modules/plugins/ui/plugin-renderer-boundary";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { SyntaxStyleVariant } from "../syntax-style";
import { getMarkdownTreeSitterClient } from "../tree-sitter-client";
import { useSyntaxStyle } from "../use-syntax-style";

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
export type MarkdownPresentationProps = Readonly<{
	messageId?: string;
	messageType: PluginMarkdownMessageType;
	timestamp?: string;
	pluginRuntime?: PluginRuntime;
	sessionId?: string;
	isStreaming: boolean;
	text: string;
}>;

export const useMeasuredMarkdownWidth = <RenderableType extends Renderable>(
	widthRef: RefObject<RenderableType | null>,
	enabled: boolean,
	horizontalPadding = 0
): Readonly<{
	availableWidth: number | undefined;
	onSizeChange: () => void;
}> => {
	const [availableWidth, setAvailableWidth] = useState<number>();
	const measureAvailableWidth = useCallback(() => {
		if (!enabled) {
			return;
		}
		const width = widthRef.current?.width;
		const measuredWidth =
			width === undefined ? undefined : width - horizontalPadding;
		if (
			measuredWidth === undefined ||
			measuredWidth <= 0 ||
			!Number.isFinite(measuredWidth)
		) {
			return;
		}
		setAvailableWidth((current) =>
			current === measuredWidth ? current : measuredWidth
		);
	}, [enabled, horizontalPadding, widthRef]);
	const onSizeChange = useCallback(() => {
		queueMicrotask(measureAvailableWidth);
	}, [measureAvailableWidth]);
	useEffect(() => {
		measureAvailableWidth();
	}, [measureAvailableWidth]);
	return { availableWidth, onSizeChange };
};

export const useMarkdownTransformation = (
	props: MarkdownPresentationProps,
	availableWidth: number | undefined
): string => {
	const {
		isStreaming,
		messageId,
		messageType,
		pluginRuntime,
		sessionId,
		text,
		timestamp,
	} = props;
	usePluginRendererRevision(pluginRuntime);
	if (
		availableWidth === undefined ||
		pluginRuntime === undefined ||
		!pluginRuntime.hasMarkdownTransformers(messageType, sessionId)
	) {
		return text;
	}
	return pluginRuntime.transformMarkdown(
		text,
		Object.freeze({
			availableWidth,
			isStreaming,
			messageId,
			messageType,
			timestamp,
		}),
		sessionId
	);
};

const useMarkdownContent = (
	props: MarkdownPresentationProps,
	widthRef: RefObject<BoxRenderable | null>,
	horizontalPadding = 0
) => {
	const enabled =
		props.pluginRuntime?.hasMarkdownTransformers(
			props.messageType,
			props.sessionId
		) ?? false;
	const { availableWidth, onSizeChange } = useMeasuredMarkdownWidth(
		widthRef,
		enabled,
		horizontalPadding
	);
	return {
		content: useMarkdownTransformation(props, availableWidth),
		widthRef,
		onSizeChange,
	};
};

export const MarkdownContent = memo(function MarkdownContent({
	text,
	pluginRuntime,
	sessionId,
	messageId,
	messageType = "user",
	streaming = true,
	isStreaming = false,
	variant = "standard",
}: {
	text: string;
	pluginRuntime?: PluginRuntime;
	sessionId?: string;
	messageId?: string;
	messageType?: PluginMarkdownMessageType;
	streaming?: boolean;
	isStreaming?: boolean;
	variant?: SyntaxStyleVariant;
}) {
	const syntaxStyle = useSyntaxStyle(variant);
	const widthRef = useRef<BoxRenderable>(null);
	const { content, onSizeChange } = useMarkdownContent(
		{
			messageId,
			messageType,
			pluginRuntime,
			sessionId,
			isStreaming,
			text,
		},
		widthRef
	);
	const sanitized = useMemo(
		() => stripMarkdownControlCharacters(content),
		[content]
	);

	return (
		<box onSizeChange={onSizeChange} ref={widthRef} width="100%">
			<markdown
				conceal
				content={sanitized}
				internalBlockMode="top-level"
				streaming={streaming}
				syntaxStyle={syntaxStyle}
				treeSitterClient={getMarkdownTreeSitterClient()}
				width="100%"
			/>
		</box>
	);
});

export const MarkdownMessagePart = memo(function MarkdownMessagePart({
	text,
	streaming = false,
	variant = "standard",
	pluginRuntime,
	sessionId,
	messageId,
	messageType = "assistant",
}: {
	text: string;
	streaming?: boolean;
	variant?: SyntaxStyleVariant;
	pluginRuntime?: PluginRuntime;
	sessionId?: string;
	messageId?: string;
	messageType?: PluginMarkdownMessageType;
}) {
	const syntaxStyle = useSyntaxStyle(variant);
	const { colors } = useTheme();
	const widthRef = useRef<BoxRenderable>(null);
	const { content: transformed, onSizeChange } = useMarkdownContent(
		{
			messageId,
			messageType,
			pluginRuntime,
			sessionId,
			isStreaming: streaming,
			text,
		},
		widthRef,
		1
	);
	const content = useMemo(() => {
		const sanitized = stripMarkdownControlCharacters(transformed);
		return variant === "thinking" ? sanitized : sanitized.trim();
	}, [transformed, variant]);

	if (!content) {
		return null;
	}

	return (
		<box
			flexShrink={0}
			onSizeChange={onSizeChange}
			paddingLeft={1}
			ref={widthRef}
			width="100%"
		>
			<markdown
				conceal
				content={content}
				fg={variant === "thinking" ? colors.thinkingText : colors.text}
				internalBlockMode="top-level"
				streaming={streaming}
				syntaxStyle={syntaxStyle}
				tableOptions={{ style: "grid", cellPaddingX: 1 }}
				treeSitterClient={getMarkdownTreeSitterClient()}
				width="100%"
			/>
		</box>
	);
});
