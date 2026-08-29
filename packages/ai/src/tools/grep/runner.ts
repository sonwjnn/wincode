import {
	defaultWorkspaceSandbox,
	WORKSPACE,
	WORKSPACE_IGNORED_DIRECTORY_NAMES,
} from "../../workspace";
import { fitsSerializedBytes } from "../output-bounds";
import {
	getToolResourceLimits,
	type ResourceLimitOptions,
	type ToolResourceLimits,
} from "../resource-limits";
import type { GrepSearch, GrepSearchInput, GrepSearchResult } from "./backend";
import { runJavascriptGrep, validateGrepPattern } from "./javascript";
import {
	RipgrepInvalidPatternError,
	RipgrepUnavailableError,
	runRipgrepSearch,
} from "./ripgrep";
import type { GrepInput, GrepOutput } from "./schema";

export type GrepRunnerOptions = ResourceLimitOptions;

const resolveSearchInput = async (
	input: GrepInput,
	limits: ToolResourceLimits
): Promise<GrepSearchInput> => {
	const resolvedPath = await defaultWorkspaceSandbox.resolveExistingPath(
		input.path ?? "."
	);
	return {
		cwd: WORKSPACE,
		ignoredDirectoryNames: [...WORKSPACE_IGNORED_DIRECTORY_NAMES],
		maxDepth: limits.grep.maxDepth,
		maxDurationMs: limits.grep.maxDurationMs,
		maxFileBytes: limits.grep.maxFileBytes,
		maxFiles: limits.grep.maxFiles,
		maxLineBytes: limits.grep.maxLineBytes,
		maxMatches: limits.grep.maxMatches,
		path: defaultWorkspaceSandbox.relativePath(resolvedPath) || ".",
		pattern: input.pattern,
	};
};

const formatGrepOutput = (
	result: GrepSearchResult,
	maxOutputBytes: number
): GrepOutput => {
	const matches: GrepOutput["matches"] = [];
	for (const match of result.matches) {
		matches.push(match);
		if (!fitsSerializedBytes({ matches }, maxOutputBytes)) {
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
	async (
		input: GrepInput,
		options: GrepRunnerOptions = {}
	): Promise<GrepOutput> => {
		validateGrepPattern(input.pattern);
		const limits = options.resourceLimits ?? getToolResourceLimits();
		const searchInput = await resolveSearchInput(input, limits);

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

		return formatGrepOutput(result, limits.grep.maxOutputBytes);
	};

export const runGrepTool = createGrepRunner();
