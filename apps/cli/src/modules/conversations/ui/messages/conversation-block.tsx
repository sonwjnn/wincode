import type { BoxRenderable } from "@opentui/core";
import type { ReactNode, Ref } from "react";
import { EmptyBorder } from "@/shared/constants";
import type { ThemeColors } from "@/shared/providers/theme/themes";

type ConversationBlockProps = {
	blockRef?: Ref<BoxRenderable>;
	borderColor?: string;
	children: ReactNode;
	colors: ThemeColors;
	contentBackgroundColor?: string;
	contentGap?: number;
	contentJustifyContent?: "center";
	customBorderChars?: Partial<typeof EmptyBorder>;
	marginBottom?: number;
	onMouseDown?: () => void;
	onSizeChange?: () => void;
	paddingX?: number;
	paddingY?: number;
};

export function ConversationBlock({
	blockRef,
	borderColor,
	children,
	colors,
	contentBackgroundColor,
	contentGap = 1,
	contentJustifyContent,
	customBorderChars,
	marginBottom = 1,
	onMouseDown,
	onSizeChange,
	paddingX = 2,
	paddingY = 1,
}: ConversationBlockProps) {
	const resolvedBorderColor = borderColor ?? colors.backgroundElement;
	const resolvedContentBackground =
		contentBackgroundColor ?? colors.backgroundElement;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Conversation blocks own terminal mouse interaction when a caller provides it.
		<box
			border={["left"]}
			borderColor={resolvedBorderColor}
			customBorderChars={{
				...EmptyBorder,
				vertical: "┃",
				...customBorderChars,
			}}
			flexDirection="column"
			marginBottom={marginBottom}
			onMouseDown={onMouseDown}
			onSizeChange={onSizeChange}
			ref={blockRef}
			width="100%"
		>
			<box
				backgroundColor={resolvedContentBackground}
				flexDirection="column"
				gap={contentGap}
				justifyContent={contentJustifyContent}
				paddingX={paddingX}
				paddingY={paddingY}
				width="100%"
			>
				{children}
			</box>
		</box>
	);
}
