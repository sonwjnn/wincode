import type { ModeType } from "@wincode/ai";
import { findFileMentionRanges } from "@/modules/file-mentions";
import { EmptyBorder } from "@/shared/constants";
import { useTheme } from "@/shared/providers/theme/theme-provider";

type UserMessageProps = {
	message: string;
	mode: ModeType;
};

const getMessageParts = (message: string) => {
	const fileMentionRanges = findFileMentionRanges(message);
	let body = "";
	let lastIndex = 0;

	for (const range of fileMentionRanges) {
		body += message.slice(lastIndex, range.start);
		lastIndex = range.end;
	}

	body += message.slice(lastIndex);

	return {
		body: body.replace(/[ \t]{2,}/gu, " ").trim(),
		fileMentions: fileMentionRanges.map(({ query, start }) => ({
			path: query,
			start,
		})),
	};
};

const getMentionTypeLabel = (path: string) =>
	path.endsWith("/") ? "Directory" : "File";

export function UserMessage({ message, mode }: UserMessageProps) {
	const { colors } = useTheme();
	const borderColor = colors.mode[mode];
	const { body, fileMentions } = getMessageParts(message);

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
					flexDirection="column"
					width="100%"
				>
					{body && (
						<box justifyContent="center" paddingX={2} paddingY={1} width="100%">
							<text>{body}</text>
						</box>
					)}

					{fileMentions.length > 0 && (
						<box
							flexDirection="row"
							flexWrap="wrap"
							gap={1}
							paddingBottom={1}
							paddingX={2}
							width="100%"
						>
							{fileMentions.map(({ path, start }) => (
								<box
									alignItems="center"
									flexDirection="row"
									flexShrink={0}
									key={`${start}:${path}`}
								>
									<box
										backgroundColor={colors.fileBadgeBackground}
										paddingX={1}
									>
										<text fg={colors.fileBadgeText}>
											<strong>{getMentionTypeLabel(path)}</strong>
										</text>
									</box>
									<box backgroundColor={colors.filePathBackground} paddingX={1}>
										<text fg={colors.filePath}>{path}</text>
									</box>
								</box>
							))}
						</box>
					)}
				</box>
			</box>
		</box>
	);
}
