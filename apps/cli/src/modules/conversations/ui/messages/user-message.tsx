import type { AgentId, CodingAgentUIMessage } from "@wincode/ai";
import { findFileMentionRanges } from "@/modules/file-mentions";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { getAgentColor } from "@/shared/providers/theme/themes";
import { BorderedContentBlock } from "@/shared/ui/bordered-content-block";
import { ATTACHMENT_ID_DISPLAY_LENGTH } from "../../storage/attachment-store";

type UserMessageProps = {
	agent: AgentId;
	appliedSkill?: AppliedSkill;
	parts: CodingAgentUIMessage["parts"];
};

export type AppliedSkill = {
	arguments?: string;
	contentHash: string;
	name: string;
	source?: "agent" | "explicit";
};

type TextPart = Extract<
	CodingAgentUIMessage["parts"][number],
	{ type: "text" }
>;

type FilePart = Extract<
	CodingAgentUIMessage["parts"][number],
	{ type: "file" }
>;

type AttachmentDisplayPart = FilePart & {
	attachmentId?: string;
	available?: boolean;
	displayAvailability?: "missing";
};

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
const isUnavailableAttachment = (
	part: FilePart
): part is AttachmentDisplayPart =>
	("available" in part && part.available === false) ||
	("displayAvailability" in part && part.displayAvailability === "missing");
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

export const getAppliedSkill = (
	metadata: unknown
): AppliedSkill | undefined => {
	if (!isRecord(metadata)) {
		return;
	}
	if (!isRecord(metadata.skill)) {
		return;
	}

	const skill = metadata.skill;
	if (
		typeof skill.contentHash !== "string" ||
		typeof skill.name !== "string" ||
		skill.name.length === 0
	) {
		return;
	}

	return {
		...(typeof skill.arguments === "string"
			? { arguments: skill.arguments }
			: {}),
		contentHash: skill.contentHash,
		name: skill.name,
		...(skill.source === "agent" || skill.source === "explicit"
			? { source: skill.source }
			: {}),
	};
};

const getImageLabel = (part: FilePart, hasFileMentions: boolean): string => {
	if (isUnavailableAttachment(part)) {
		return `Unavailable (${part.attachmentId?.slice(0, ATTACHMENT_ID_DISPLAY_LENGTH) ?? "attachment"})`;
	}
	return hasFileMentions ? "clipboard" : (part.filename ?? "attachment");
};
const getImageBadgeKeys = (
	parts: FilePart[]
): Array<{ key: string; part: FilePart }> => {
	const counts = new Map<string, number>();
	return parts.map((part) => {
		const id = (part as AttachmentDisplayPart).attachmentId ?? part.url;
		const occurrence = counts.get(id) ?? 0;
		counts.set(id, occurrence + 1);
		return { key: `${id}:${occurrence}`, part };
	});
};
export function UserMessage({ agent, appliedSkill, parts }: UserMessageProps) {
	const { colors } = useTheme();

	const borderColor = getAgentColor(colors, agent);
	const message = parts
		.filter(isTextPart)
		.map((part) => part.text)
		.join("");
	const imageParts = parts.filter(isImagePart);
	const { body, fileMentions } = getMessageParts(message);
	const hasAttachmentBadges = fileMentions.length > 0 || imageParts.length > 0;
	const hasBadges = appliedSkill !== undefined || hasAttachmentBadges;

	return (
		<box alignItems="center" width="100%">
			<BorderedContentBlock
				borderColor={borderColor}
				colors={colors}
				contentBackgroundColor={colors.backgroundPanel}
				contentGap={0}
				customBorderChars={{
					bottomLeft: "╹",
					topLeft: "╻",
				}}
				marginBottom={0}
				paddingX={0}
				paddingY={0}
			>
				{body && (
					<box justifyContent="center" paddingX={2} paddingY={1} width="100%">
						<text fg={colors.text}>{body}</text>
					</box>
				)}

				{hasBadges && (
					<box
						flexDirection="row"
						flexWrap="wrap"
						gap={1}
						paddingBottom={1}
						paddingX={2}
						width="100%"
					>
						{appliedSkill && (
							<box alignItems="center" flexDirection="row" flexShrink={0}>
								<box backgroundColor={colors.fileBadgeBackground} paddingX={1}>
									<text fg={colors.fileBadgeText}>
										<strong>Skill</strong>
									</text>
								</box>
								<box backgroundColor={colors.filePathBackground} paddingX={1}>
									<text fg={colors.filePath}>{appliedSkill.name}</text>
								</box>
							</box>
						)}

						{fileMentions.map(({ path, start }) => (
							<box
								alignItems="center"
								flexDirection="row"
								flexShrink={0}
								key={`${start}:${path}`}
							>
								<box backgroundColor={colors.fileBadgeBackground} paddingX={1}>
									<text fg={colors.fileBadgeText}>
										<strong>{getMentionTypeLabel(path)}</strong>
									</text>
								</box>
								<box backgroundColor={colors.filePathBackground} paddingX={1}>
									<text fg={colors.filePath}>{path}</text>
								</box>
							</box>
						))}

						{getImageBadgeKeys(imageParts).map(({ key, part }) => (
							<box
								alignItems="center"
								flexDirection="row"
								flexShrink={0}
								key={key}
							>
								<box backgroundColor={colors.fileBadgeBackground} paddingX={1}>
									<text fg={colors.fileBadgeText}>
										<strong>File</strong>
									</text>
								</box>
								<box backgroundColor={colors.filePathBackground} paddingX={1}>
									<text fg={colors.filePath}>
										{getImageLabel(part, fileMentions.length > 0)}
									</text>
								</box>
							</box>
						))}
					</box>
				)}
			</BorderedContentBlock>
		</box>
	);
}
