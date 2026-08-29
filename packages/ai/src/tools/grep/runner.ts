import {
	defaultWorkspaceSandbox,
	WORKSPACE,
	WORKSPACE_IGNORED_DIRECTORY_NAMES,
} from "../../workspace";
import { fitsSerializedBytes } from "../output-bounds";
import type { GrepSearch, GrepSearchInput, GrepSearchResult } from "./backend";
import { runJavascriptGrep, validateGrepPattern } from "./javascript";
import {
	RipgrepInvalidPatternError,
	RipgrepUnavailableError,
	runRipgrepSearch,
} from "./ripgrep";
import type { GrepInput, GrepOutput } from "./schema";

const GREP_MAX_DEPTH = 5;
const GREP_MAX_FILE_BYTES = 1_000_000;
const GREP_MAX_FILES = 1000;
const GREP_MAX_MATCHES = 1000;
const GREP_OUTPUT_MAX_BYTES = 6000;
const GREP_LINE_MAX_BYTES = 1000;

const resolveSearchInput = async (
	input: GrepInput
): Promise<GrepSearchInput> => {
	const resolvedPath = await defaultWorkspaceSandbox.resolveExistingPath(
		input.path ?? "."
	);
	return {
		cwd: WORKSPACE,
		ignoredDirectoryNames: [...WORKSPACE_IGNORED_DIRECTORY_NAMES],
		maxDepth: GREP_MAX_DEPTH,
		maxFileBytes: GREP_MAX_FILE_BYTES,
		maxFiles: GREP_MAX_FILES,
		maxLineBytes: GREP_LINE_MAX_BYTES,
		maxMatches: GREP_MAX_MATCHES,
		path: defaultWorkspaceSandbox.relativePath(resolvedPath) || ".",
		pattern: input.pattern,
	};
};

const formatGrepOutput = (result: GrepSearchResult): GrepOutput => {
	const matches: GrepOutput["matches"] = [];
	for (const match of result.matches) {
		matches.push(match);
		if (!fitsSerializedBytes({ matches }, GREP_OUTPUT_MAX_BYTES)) {
			matches.pop();
			return { matches, truncated: true };
		}
	}
	return result.truncated ? { matches, truncated: true } : { matches };
};

export type GrepRunnerDeps = {
	fallbackSearch?: GrepSearch;
	search?: GrepSearch;
};

export const createGrepRunner =
	({
		fallbackSearch = runJavascriptGrep,
		search = runRipgrepSearch,
	}: GrepRunnerDeps = {}) =>
	async (input: GrepInput): Promise<GrepOutput> => {
		validateGrepPattern(input.pattern);
		const searchInput = await resolveSearchInput(input);

		let result: GrepSearchResult;
		try {
			result = await search(searchInput);
		} catch (error) {
			if (
				!(
					error instanceof RipgrepInvalidPatternError ||
					error instanceof RipgrepUnavailableError
				)
			) {
				throw error;
			}
			result = await fallbackSearch(searchInput);
		}

		return formatGrepOutput(result);
	};

export const runGrepTool = createGrepRunner();
