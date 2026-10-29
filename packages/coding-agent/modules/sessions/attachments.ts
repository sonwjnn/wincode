import type { Extmark } from "@opentui/core";
import { isUndefined } from "@wincode/utils";
import type { SessionFilePart } from "@/modules/sessions/message";

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

const hasUniqueTokenOccurrence = (text: string, token: string): boolean => {
	const first = text.indexOf(token);
	return first !== -1 && first === text.lastIndexOf(token);
};

/** Keeps ambiguous tokens at their mapped range; only unique tokens can move. */
const findTrackedTokenStart = (
	text: string,
	token: string,
	candidates: readonly number[],
	expectedStart: number | undefined,
	previousText: string | undefined
): number | undefined => {
	if (isUndefined(expectedStart)) {
		return candidates[0];
	}
	if (candidates.includes(expectedStart)) {
		return expectedStart;
	}
	if (
		previousText !== undefined &&
		hasUniqueTokenOccurrence(previousText, token) &&
		hasUniqueTokenOccurrence(text, token)
	) {
		return candidates[0];
	}
};

const findUnclaimedTokenOccurrences = (
	text: string,
	token: string,
	claimedStarts: ReadonlySet<number>
): number[] => {
	const candidates: number[] = [];
	let start = text.indexOf(token);
	while (start !== -1) {
		if (!claimedStarts.has(start)) {
			candidates.push(start);
		}
		start = text.indexOf(token, start + token.length);
	}
	return candidates;
};

export const locateTrackedTokenOccurrences = <T extends { token: string }>(
	text: string,
	records: readonly T[],
	expectedStarts: readonly number[] = [],
	previousText?: string
): Array<{ record: T; start: number }> => {
	const claimedStarts = new Set<number>();
	return records.flatMap((record, index) => {
		const candidates = findUnclaimedTokenOccurrences(
			text,
			record.token,
			claimedStarts
		);
		const matchedStart = findTrackedTokenStart(
			text,
			record.token,
			candidates,
			expectedStarts[index],
			previousText
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
	expectedStarts: readonly number[] = []
): Array<{ attachment: ChatAttachment; start: number }> =>
	locateTrackedTokenOccurrences(text, attachments, expectedStarts).map(
		({ record: attachment, start }) => ({ attachment, start })
	);

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
