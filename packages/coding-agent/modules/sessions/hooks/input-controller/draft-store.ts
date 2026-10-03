import { replaceTextRanges } from "@/shared/utils/text-ranges";
import { findImageTokenRanges } from "../../attachments";
import { stripPastedTextTokens } from "../../pasted-text";

const MAX_COMPOSER_DRAFTS = 64;

const composerDrafts = new Map<string, string>();

/**
 * Attachment and paste markers are plain text, but their payloads live in
 * composer refs that a remount drops. Restoring the marker without the payload
 * would silently submit the marker literal, so those markers are removed.
 */
const stripUnrecoverableTokens = (text: string): string => {
	const stripped = stripPastedTextTokens(text);
	return replaceTextRanges(
		stripped,
		findImageTokenRanges(stripped).map(({ start, token }) => ({
			end: start + token.length,
			start,
			text: "",
		}))
	);
};

/**
 * Composer text that must survive a subtree remount (an error boundary
 * Continue) without touching durable storage. Dropped once submitted.
 */
export const restoreComposerDraft = (key: string): string =>
	stripUnrecoverableTokens(composerDrafts.get(key) ?? "");

export const writeComposerDraft = (key: string, text: string): void => {
	if (text.length === 0) {
		composerDrafts.delete(key);
		return;
	}
	if (!composerDrafts.has(key) && composerDrafts.size >= MAX_COMPOSER_DRAFTS) {
		const oldestKey = composerDrafts.keys().next().value;
		if (oldestKey !== undefined) {
			composerDrafts.delete(oldestKey);
		}
	}
	composerDrafts.set(key, text);
};
