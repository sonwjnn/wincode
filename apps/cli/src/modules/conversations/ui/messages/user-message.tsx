import type { CodingAgentUIMessage, ModeType } from "@wincode/ai";
import { findFileMentionRanges } from "@/modules/file-mentions";
import { EmptyBorder } from "@/shared/constants";
import { useTheme } from "@/shared/providers/theme/theme-provider";

type UserMessageProps = {
	mode: ModeType;
	parts: CodingAgentUIMessage["parts"];
};

type TextPart = Extract<
	CodingAgentUIMessage["parts"][number],
	{ type: "text" }
>;

type FilePart = Extract<
	CodingAgentUIMessage["parts"][number],
	{ type: "file" }
>;

const INLINE_IMAGE_TOKEN = /\[Image \d+\]/u;

export const hasInlineImageToken = (message: string) =>
	INLINE_IMAGE_TOKEN.test(message);

const isTextPart = (
	part: CodingAgentUIMessage["parts"][number]
): part is TextPart => part.type === "text";

const isImagePart = (
	part: CodingAgentUIMessage["parts"][number]
): part is FilePart =>
	part.type === "file" && part.mediaType.startsWith("image/");

const getMessageParts = (message: string) => {
	const fileMentionRanges = findFileMentionRanges(message);

	return {
		body: message.trim(),
		fileMentions: fileMentionRanges.map(({ query, start }) => ({
			path: query,
			start,
		})),
	};
};

const getMentionTypeLabel = (path: string) =>
	path.endsWith("/") ? "Directory" : "File";

export function UserMessage({ mode, parts }: UserMessageProps) {
	const { colors } = useTheme();
	const borderColor = colors.mode[mode];
	const message = parts
		.filter(isTextPart)
		.map((part) => part.text)
		.join("");
	const imageParts = parts.filter(isImagePart);
	const { body, fileMentions } = getMessageParts(message);

	return (
		<box alignItems="center" width="100%">
			<box
				border={["left"]}
				borderColor={borderColor}
				customBorderChars={{
					...EmptyBorder,
					bottomLeft: "╹",
					topLeft: "╻",
					vertical: "┃",
				}}
				width="100%"
			>
				<box
					backgroundColor={colors.backgroundPanel}
					flexDirection="column"
					width="100%"
				>
					{body && (
						<box justifyContent="center" paddingX={2} paddingY={1} width="100%">
							<text fg={colors.text}>{body}</text>
						</box>
					)}

					{(fileMentions.length > 0 || imageParts.length > 0) && (
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

							{imageParts.map((part) => (
								<box
									alignItems="center"
									flexDirection="row"
									flexShrink={0}
									key={part.url}
								>
									<box
										backgroundColor={colors.fileBadgeBackground}
										paddingX={1}
									>
										<text fg={colors.fileBadgeText}>
											<strong>File</strong>
										</text>
									</box>
									<box backgroundColor={colors.filePathBackground} paddingX={1}>
										<text fg={colors.filePath}>
											{fileMentions.length > 0 ? "clipboard" : part.filename}
										</text>
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
