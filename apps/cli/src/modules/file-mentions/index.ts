export type { FileMentionOption } from "./types";
// biome-ignore lint/performance/noBarrelFile: intentional public API for cross-module access
export { FileMentionMenu } from "./ui/file-mention-menu";
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
