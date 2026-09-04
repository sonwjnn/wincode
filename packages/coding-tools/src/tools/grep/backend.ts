export type GrepSearchInput = {
	cwd: string;
	ignoredDirectoryNames: readonly string[];
	maxDepth: number;
	maxDurationMs?: number;
	maxFileBytes: number;
	maxFiles: number;
	maxLineBytes: number;
	maxMatches: number;
	path: string;
	pattern: string;
};

export type GrepSearchMatch = {
	line: string;
	lineNumber: number;
	path: string;
};

export type GrepSearchResult = {
	matches: GrepSearchMatch[];
	truncated?: boolean;
};

export type GrepSearch = (input: GrepSearchInput) => Promise<GrepSearchResult>;
