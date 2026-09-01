import type { Extmark } from "@opentui/core";
import type { FileUIPart } from "@wincode/ai/client";

export type ChatAttachment = {
	extmarkId: number;
	file: FileUIPart;
	id: string;
	token: string;
};

export const getImageToken = (label: number) => `[Image ${label}]`;
export const getNextImageLabel = (attachmentCount: number): number =>
	attachmentCount + 1;

export const isAttachmentTokenExtant = (
	text: string,
	token: string,
	extmark: Pick<Extmark, "end" | "start">
) => text.slice(extmark.start, extmark.end) === token;

export const locateAttachmentTokens = (
	text: string,
	attachments: ChatAttachment[],
	expectedStarts: number[] = []
): Array<{ attachment: ChatAttachment; start: number }> => {
	const claimedStarts = new Set<number>();
	return attachments.flatMap((attachment, index) => {
		const candidates: number[] = [];
		let start = text.indexOf(attachment.token);
		while (start !== -1) {
			if (!claimedStarts.has(start)) {
				candidates.push(start);
			}
			start = text.indexOf(attachment.token, start + attachment.token.length);
		}

		const expectedStart = expectedStarts[index];
		const matchedStart =
			expectedStart === undefined
				? candidates[0]
				: candidates.toSorted(
						(left, right) =>
							Math.abs(left - expectedStart) - Math.abs(right - expectedStart)
					)[0];
		if (matchedStart === undefined) {
			return [];
		}
		claimedStarts.add(matchedStart);
		return [{ attachment, start: matchedStart }];
	});
};

export const mapOffsetThroughTextReplacement = (
	previousText: string,
	nextText: string,
	offset: number
): number => {
	let prefixLength = 0;
	const maxPrefixLength = Math.min(previousText.length, nextText.length);
	while (
		prefixLength < maxPrefixLength &&
		previousText[prefixLength] === nextText[prefixLength]
	) {
		prefixLength += 1;
	}

	let suffixLength = 0;
	while (
		suffixLength < previousText.length - prefixLength &&
		suffixLength < nextText.length - prefixLength &&
		previousText.at(-suffixLength - 1) === nextText.at(-suffixLength - 1)
	) {
		suffixLength += 1;
	}

	if (offset <= prefixLength) {
		return offset;
	}
	if (offset >= previousText.length - suffixLength) {
		return nextText.length - (previousText.length - offset);
	}
	return prefixLength;
};

export const normalizeFileTokensForTrimmedText = (
	rawText: string,
	fileTokens: Array<{ start: number; token: string }>
): Array<{ start: number; token: string }> => {
	const text = rawText.trim();
	const leadingTrimLength = rawText.length - rawText.trimStart().length;
	return fileTokens.map(({ start: rawStart, token }) => {
		const start = rawStart - leadingTrimLength;
		return {
			start,
			token: text
				.slice(start, Math.min(text.length, start + token.length))
				.trimEnd(),
		};
	});
};

export const areFileMentionExtmarksCurrent = (
	ranges: Array<{ end: number; start: number }>,
	extmarks: Array<Pick<Extmark, "end" | "start" | "styleId"> | null>,
	styleId: number
): boolean =>
	ranges.length === extmarks.length &&
	ranges.every((range, index) => {
		const extmark = extmarks[index];
		return (
			extmark?.start === range.start &&
			extmark.end === range.end &&
			extmark.styleId === styleId
		);
	});

type ImageTokenRange = {
	label: number;
	start: number;
	token: string;
};

const IMAGE_TOKEN_PATTERN = /\[Image (\d+)\]/gu;

export const findImageTokenRanges = (text: string): ImageTokenRange[] =>
	Array.from(text.matchAll(IMAGE_TOKEN_PATTERN), (match) => ({
		label: Number(match[1]),
		start: match.index,
		token: match[0],
	}));

export type {
	AttachmentExternalizationOptions,
	AttachmentHydrationOptions,
	AttachmentHydrationPurpose,
	AttachmentHydrationStats,
	AttachmentInput,
	AttachmentMaintenanceReport,
	AttachmentMetadataRecord,
	AttachmentMetadataRepository,
	AttachmentReference,
	AttachmentReferenceFilePart,
	AttachmentResolution,
	CompactionAttachmentMetadata,
	ConversationAttachmentStore,
	ConversationAttachmentStoreOptions,
} from "./storage/attachment-store";
export {
	ATTACHMENT_ID_DISPLAY_LENGTH,
	ATTACHMENT_ID_PATTERN,
	ATTACHMENT_URL_PREFIX,
	attachmentReferenceSchema,
	attachmentReferenceToFilePart,
	createConversationAttachmentStore,
	createDrizzleAttachmentMetadataRepository,
	createMemoryAttachmentMetadataRepository,
	DEFAULT_ATTACHMENT_MAINTENANCE_LIMITS,
	DEFAULT_COMPACTION_ATTACHMENT_BUDGET,
	DEFAULT_MODEL_ATTACHMENT_BUDGET,
	detectImageMediaType,
	estimateAttachmentTokens,
	formatAttachmentUnavailableMarker,
	getAttachmentReference,
	isAttachmentReference,
	isAttachmentReferencePart,
	isLegacyImagePart,
	MAX_ATTACHMENT_BYTES,
	MAX_COMPACTION_ATTACHMENT_REFERENCES,
	messageHasLegacyImageParts,
	stripAttachmentDisplayMetadata,
} from "./storage/attachment-store";
