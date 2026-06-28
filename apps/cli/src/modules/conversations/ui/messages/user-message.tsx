import type { ModeType } from "@wincode/ai";
import type { ReactNode } from "react";
import { findFileMentionRanges } from "@/modules/file-mentions";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { EmptyBorder } from "@/shared/terminal/ui/borders";

type UserMessageProps = {
	message: string;
	mode: ModeType;
};

const renderMessageWithMentions = (message: string, mentionColor: string) => {
	const chunks: ReactNode[] = [];
	let lastIndex = 0;

	for (const range of findFileMentionRanges(message)) {
		if (range.start > lastIndex) {
			chunks.push(message.slice(lastIndex, range.start));
		}

		const mention = message.slice(range.start, range.end);
		chunks.push(
			<span fg={mentionColor} key={`${range.start}:${mention}`}>
				<strong>{mention}</strong>
			</span>
		);
		lastIndex = range.end;
	}

	if (lastIndex < message.length) {
		chunks.push(message.slice(lastIndex));
	}

	return chunks.length === 0 ? message : chunks;
};

export function UserMessage({ message, mode }: UserMessageProps) {
	const { colors } = useTheme();
	const borderColor = colors.mode[mode];
	const content = renderMessageWithMentions(message, colors.primary);

	return (
		<box alignItems="center" width="100%">
			<box
				border={["left"]}
				borderColor={borderColor}
				customBorderChars={{
					...EmptyBorder,
					bottomLeft: "╹",
					vertical: "┃",
				}}
				width="100%"
			>
				<box
					backgroundColor={colors.surface}
					justifyContent="center"
					paddingBottom={1}
					paddingTop={1}
					paddingX={2}
					width="100%"
				>
					<text>{content}</text>
				</box>
			</box>
		</box>
	);
}
