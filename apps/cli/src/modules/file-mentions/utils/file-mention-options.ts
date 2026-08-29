import path from "node:path";

import {
	createWorkspaceSandbox,
	traverseWorkspaceEntries,
} from "@wincode/ai/workspace";

import type { FileMentionOption } from "../types";

const MAX_FILE_MENTION_RESULTS = 100;
const UNLIMITED_DISCOVERY_DEPTH = Number.POSITIVE_INFINITY;

type FileMentionOptionsOptions = {
	root?: string;
};

type Match = {
	gaps: number;
	rank: number;
	specificity: number;
	start: number;
};

type RankedOption = {
	basenameLength: number;
	index: number;
	match: Match;
	option: FileMentionOption;
	pathDepth: number;
};
const LEADING_CURRENT_DIRECTORY_RE = /^\.\/+/u;
const TRAILING_SLASH_RE = /\/+$/u;
const BASENAME_SUBSEQUENCE_RANK = 3;
const PATH_SEGMENT_RANK = 4;
const PATH_SUBSEQUENCE_RANK = 5;

const formatOption = (
	relativePath: string,
	type: FileMentionOption["type"]
): FileMentionOption => ({
	label: type === "directory" ? `${relativePath}/` : relativePath,
	path: relativePath,
	type,
});

const compareCanonicalPaths = (
	left: FileMentionOption,
	right: FileMentionOption
) => {
	const leftPath = left.path.toLowerCase();
	const rightPath = right.path.toLowerCase();
	if (leftPath !== rightPath) {
		return leftPath < rightPath ? -1 : 1;
	}

	if (left.path !== right.path) {
		return left.path < right.path ? -1 : 1;
	}

	if (left.type !== right.type) {
		return left.type === "directory" ? -1 : 1;
	}

	if (left.label < right.label) {
		return -1;
	}

	if (left.label > right.label) {
		return 1;
	}

	return 0;
};
type NormalizedPathQuery = {
	text: string;
	trailingSlash: boolean;
};

const normalizePathQuery = (query: string): NormalizedPathQuery => {
	const withoutLeadingCurrentDirectory = query.replace(
		LEADING_CURRENT_DIRECTORY_RE,
		""
	);

	return {
		text: withoutLeadingCurrentDirectory.replace(TRAILING_SLASH_RE, ""),
		trailingSlash: TRAILING_SLASH_RE.test(withoutLeadingCurrentDirectory),
	};
};

const compareMatches = (left: Match, right: Match) =>
	left.rank - right.rank ||
	left.gaps - right.gaps ||
	left.specificity - right.specificity ||
	left.start - right.start;

const chooseBetterMatch = (left: Match | null, right: Match | null) => {
	if (!left) {
		return right;
	}
	if (!right) {
		return left;
	}

	return compareMatches(left, right) <= 0 ? left : right;
};

const findSubsequenceMatch = (
	candidate: string,
	query: string,
	rank: number
): Match | null => {
	let candidateIndex = 0;
	let previousMatchIndex = -1;
	let firstMatchIndex = -1;
	let gaps = 0;

	for (const character of query) {
		const matchIndex = candidate.indexOf(character, candidateIndex);
		if (matchIndex === -1) {
			return null;
		}

		if (firstMatchIndex === -1) {
			firstMatchIndex = matchIndex;
		}
		if (previousMatchIndex !== -1) {
			gaps += matchIndex - previousMatchIndex - 1;
		}

		previousMatchIndex = matchIndex;
		candidateIndex = matchIndex + 1;
	}

	return {
		gaps,
		rank,
		specificity: 0,
		start: firstMatchIndex,
	};
};

const getExtensionlessStem = (basename: string) => {
	const extension = path.posix.extname(basename);
	return extension ? basename.slice(0, -extension.length) : basename;
};

const getBasenameMatch = (optionPath: string, query: string): Match | null => {
	const basename = path.posix.basename(optionPath).toLowerCase();
	const stem = getExtensionlessStem(basename);

	if (basename === query || stem === query) {
		return { gaps: 0, rank: 0, specificity: 0, start: 0 };
	}

	if (basename.startsWith(query) || stem.startsWith(query)) {
		return { gaps: 0, rank: 1, specificity: 0, start: 0 };
	}

	if (basename.includes(query) || stem.includes(query)) {
		return { gaps: 0, rank: 2, specificity: 0, start: 0 };
	}

	return chooseBetterMatch(
		findSubsequenceMatch(basename, query, BASENAME_SUBSEQUENCE_RANK),
		findSubsequenceMatch(stem, query, BASENAME_SUBSEQUENCE_RANK)
	);
};

const getPathSegmentMatch = (
	optionPath: string,
	query: string
): Match | null => {
	const segments = optionPath.split("/");
	let bestMatch: Match | null = null;

	for (const [index, segment] of segments.entries()) {
		if (segment === query) {
			bestMatch = chooseBetterMatch(bestMatch, {
				gaps: 0,
				rank: PATH_SEGMENT_RANK,
				specificity: 0,
				start: index,
			});
			continue;
		}

		if (segment.includes(query)) {
			bestMatch = chooseBetterMatch(bestMatch, {
				gaps: 0,
				rank: PATH_SEGMENT_RANK,
				specificity: 1,
				start: index,
			});
		}
	}

	return bestMatch;
};

const getPathMatch = (
	optionPath: string,
	query: string,
	trailingSlash: boolean
): Match | null => {
	if (optionPath === query) {
		return { gaps: 0, rank: 0, specificity: 0, start: 0 };
	}

	if (trailingSlash) {
		if (optionPath.startsWith(`${query}/`)) {
			return { gaps: 0, rank: 1, specificity: 0, start: 0 };
		}

		const context = `/${query}/`;
		const contextStart = optionPath.indexOf(context);
		if (contextStart !== -1) {
			return {
				gaps: 0,
				rank: 2,
				specificity: 0,
				start: contextStart + 1,
			};
		}

		return null;
	}

	if (
		optionPath.startsWith(`${query}/`) ||
		optionPath.startsWith(`${query}.`)
	) {
		return { gaps: 0, rank: 1, specificity: 0, start: 0 };
	}

	if (optionPath.includes(query)) {
		return {
			gaps: 0,
			rank: 2,
			specificity: 0,
			start: optionPath.indexOf(query),
		};
	}

	return findSubsequenceMatch(optionPath, query, PATH_SUBSEQUENCE_RANK);
};

const getMatch = (
	option: FileMentionOption,
	query: string,
	pathAware: boolean,
	trailingSlash: boolean
): Match | null => {
	if (pathAware) {
		return getPathMatch(option.path.toLowerCase(), query, trailingSlash);
	}

	const basenameMatch = getBasenameMatch(option.path, query);
	if (basenameMatch) {
		return basenameMatch;
	}

	return (
		getPathSegmentMatch(option.path.toLowerCase(), query) ??
		findSubsequenceMatch(
			option.path.toLowerCase(),
			query,
			PATH_SUBSEQUENCE_RANK
		)
	);
};

const compareRankedOptions = (left: RankedOption, right: RankedOption) => {
	const matchComparison = compareMatches(left.match, right.match);
	if (matchComparison !== 0) {
		return matchComparison;
	}

	if (left.basenameLength !== right.basenameLength) {
		return left.basenameLength - right.basenameLength;
	}

	if (left.pathDepth !== right.pathDepth) {
		return left.pathDepth - right.pathDepth;
	}

	const pathComparison = compareCanonicalPaths(left.option, right.option);
	return pathComparison === 0 ? left.index - right.index : pathComparison;
};

export const getFileMentionOptions = async (
	options: FileMentionOptionsOptions = {}
): Promise<FileMentionOption[]> => {
	const policy = options.root
		? createWorkspaceSandbox(options.root)
		: undefined;
	const result = await traverseWorkspaceEntries(
		{
			includeDirectories: true,
			includeFiles: true,
			maxDepth: UNLIMITED_DISCOVERY_DEPTH,
		},
		policy
	);

	return result.entries.map((entry) =>
		formatOption(entry.relativePath, entry.type)
	);
};

export const filterFileMentionOptions = (
	options: FileMentionOption[],
	query: string
): FileMentionOption[] => {
	const normalizedQuery = query.toLowerCase();
	if (normalizedQuery.length === 0) {
		return options
			.toSorted(compareCanonicalPaths)
			.slice(0, MAX_FILE_MENTION_RESULTS);
	}

	const pathAware = normalizedQuery.includes("/");
	const pathQuery = pathAware
		? normalizePathQuery(normalizedQuery)
		: { text: normalizedQuery, trailingSlash: false };
	if (pathQuery.text.length === 0) {
		return options
			.toSorted(compareCanonicalPaths)
			.slice(0, MAX_FILE_MENTION_RESULTS);
	}

	const rankedOptions: RankedOption[] = [];
	for (const [index, option] of options.entries()) {
		const match = getMatch(
			option,
			pathQuery.text,
			pathAware,
			pathQuery.trailingSlash
		);
		if (!match) {
			continue;
		}

		rankedOptions.push({
			basenameLength: path.posix.basename(option.path).length,
			index,
			match,
			option,
			pathDepth: option.path.split("/").length,
		});
	}

	return rankedOptions
		.toSorted(compareRankedOptions)
		.slice(0, MAX_FILE_MENTION_RESULTS)
		.map(({ option }) => option);
};
