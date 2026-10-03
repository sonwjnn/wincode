const composerDrafts = new Map<string, string>();

/**
 * Composer text that must survive a subtree remount (an error boundary
 * Continue) without touching durable storage. Dropped once submitted.
 */
export const readComposerDraft = (key: string): string =>
	composerDrafts.get(key) ?? "";

export const writeComposerDraft = (key: string, text: string): void => {
	if (text.length === 0) {
		composerDrafts.delete(key);
		return;
	}
	composerDrafts.set(key, text);
};
