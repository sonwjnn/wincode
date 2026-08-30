export type GlobSearchInput = {
	cwd: string;
	gitignore: boolean;
	hidden: boolean;
	maxCandidates: number;
	maxDurationMs?: number;
	path: string;
	pattern: string;
};

export type GlobSearchResult = {
	paths: string[];
	truncated?: boolean;
};

export type GlobSearch = (input: GlobSearchInput) => Promise<GlobSearchResult>;
