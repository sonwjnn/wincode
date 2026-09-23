export type { FileMentionOption } from "./types";
export {
	filterFileMentionOptions,
	getFileMentionOptions,
} from "./utils/file-mention-options";
export {
	applyFileMentionReplacement,
	deleteFileMentionAfterTrailingCharacterDelete,
	detectFileMentionAtCursor,
	type FileMentionRange,
	type FileMentionReplacement,
	findFileMentionRanges,
	normalizeFileMentionPath,
} from "./utils/mention-grammar";
export { resolveFileMentionParts } from "./utils/resolve-file-mention-parts";
