import type { Extmark } from "@opentui/core";
import { isUndefined } from "@wincode/utils";
import type { SessionFilePart } from "@/modules/sessions/message";
import {
	findTextOccurrences,
	getLeadingTrimLength,
} from "@/shared/utils/text-ranges";

export type ChatAttachment = {
	extmarkId: number;
	file: SessionFilePart;
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

const hasUniqueTokenOccurrence = (text: string, token: string): boolean =>
	findTextOccurrences(text, token).length === 1;

const tokenContextScore = (
	previousText: string,
	previousStart: number,
	nextText: string,
	nextStart: number,
	tokenLength: number
): number => {
	let score = 0;
	for (
		let distance = 1;
		previousStart - distance >= 0 && nextStart - distance >= 0;
		distance += 1
	) {
		if (
			previousText[previousStart - distance] !== nextText[nextStart - distance]
		) {
			break;
		}
		score += 1;
	}
	for (
		let offset = 0;
		previousStart + tokenLength + offset < previousText.length &&
		nextStart + tokenLength + offset < nextText.length;
		offset += 1
	) {
		if (
			previousText[previousStart + tokenLength + offset] !==
			nextText[nextStart + tokenLength + offset]
		) {
			break;
		}
		score += 1;
	}
	return score;
};

/** Rebinds duplicate-looking markers only when their surrounding text is unique. */
const findTrackedTokenStart = <T extends { start: number; token: string }>(
	previousText: string,
	nextText: string,
	record: T,
	candidates: readonly number[]
): number | undefined => {
	if (
		hasUniqueTokenOccurrence(previousText, record.token) &&
		hasUniqueTokenOccurrence(nextText, record.token)
	) {
		return candidates[0];
	}
	if (
		previousText.slice(record.start, record.start + record.token.length) !==
		record.token
	) {
		return;
	}

	let bestStart: number | undefined;
	let bestScore = 0;
	let tied = false;
	for (const candidate of candidates) {
		const score = tokenContextScore(
			previousText,
			record.start,
			nextText,
			candidate,
			record.token.length
		);
		if (score > bestScore) {
			bestStart = candidate;
			bestScore = score;
			tied = false;
		} else if (score === bestScore && score > 0) {
			tied = true;
		}
	}
	return tied || bestScore < 2 ? undefined : bestStart;
};

const findUnclaimedTokenOccurrences = (
	text: string,
	token: string,
	claimedStarts: ReadonlySet<number>
): number[] =>
	findTextOccurrences(text, token).filter((start) => !claimedStarts.has(start));

export const locateTrackedTokenOccurrences = <
	T extends { start: number; token: string },
>(
	previousText: string,
	nextText: string,
	records: readonly T[]
): Array<{ record: T; start: number }> => {
	const claimedStarts = new Set<number>();
	return records.flatMap((record) => {
		const candidates = findUnclaimedTokenOccurrences(
			nextText,
			record.token,
			claimedStarts
		);
		const matchedStart = findTrackedTokenStart(
			previousText,
			nextText,
			record,
			candidates
		);
		if (isUndefined(matchedStart)) {
			return [];
		}
		claimedStarts.add(matchedStart);
		return [{ record, start: matchedStart }];
	});
};

export const locateAttachmentTokens = (
	text: string,
	attachments: readonly ChatAttachment[],
	expectedStarts: readonly number[]
): Array<{ attachment: ChatAttachment; start: number }> =>
	attachments.flatMap((attachment, index) => {
		const start = expectedStarts[index];
		return !isUndefined(start) &&
			text.slice(start, start + attachment.token.length) === attachment.token
			? [{ attachment, start }]
			: [];
	});

export type TextEditRegion = Readonly<{
	/** Characters identical at the start of both texts. */
	prefixLength: number;
	/** Characters identical at the end of both texts, after the prefix. */
	suffixLength: number;
}>;

/** The common-prefix/suffix region one text edit replaced or inserted. */
export const resolveTextEditRegion = (
	previousText: string,
	nextText: string
): TextEditRegion => {
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

	return { prefixLength, suffixLength };
};

export const mapOffsetThroughTextReplacement = (
	previousText: string,
	nextText: string,
	offset: number
): number => {
	const { prefixLength, suffixLength } = resolveTextEditRegion(
		previousText,
		nextText
	);

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
	const leadingTrimLength = getLeadingTrimLength(rawText);
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
