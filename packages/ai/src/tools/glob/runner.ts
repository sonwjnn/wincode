import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { defaultWorkspaceSandbox, WORKSPACE } from "../../workspace";
import { fitsSerializedBytes } from "../output-bounds";
import {
	getToolResourceLimits,
	type ResourceLimitOptions,
	type ToolResourceLimits,
} from "../resource-limits";
import type { GlobSearch, GlobSearchInput } from "./backend";
import { runRipgrepGlob } from "./ripgrep";
import {
	GLOB_DEFAULT_LIMIT,
	GLOB_MAX_LIMIT,
	type GlobInput,
	type GlobOutput,
} from "./schema";

export type GlobToolOptions = ResourceLimitOptions;

const resolveSearchInput = async (
	input: GlobInput,
	limits: ToolResourceLimits
): Promise<GlobSearchInput> => {
	const resolvedPath = await defaultWorkspaceSandbox.resolveExistingPath(
		input.path ?? "."
	);
	return {
		cwd: WORKSPACE,
		gitignore: input.gitignore ?? true,
		hidden: input.hidden ?? false,
		maxCandidates: limits.glob.maxCandidates,
		maxDurationMs: limits.glob.maxDurationMs,
		path: defaultWorkspaceSandbox.relativePath(resolvedPath) || ".",
		pattern: input.pattern,
	};
};

type GlobCandidate = {
	mtimeMs: number;
	path: string;
};

const GIT_DIRECTORY_PATH = /(?:^|\/)\.git(?:\/|$)/u;
const compareCandidates = (left: GlobCandidate, right: GlobCandidate): number =>
	right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path);

type GlobStat = (filePath: string) => Promise<Stats>;

export type GlobRunnerDeps = {
	search?: GlobSearch;
	statFile?: GlobStat;
};

const collectStatCandidates = async (
	paths: readonly string[],
	statFile: GlobStat
): Promise<GlobCandidate[]> => {
	const candidates: GlobCandidate[] = [];
	for (const relativePath of paths) {
		if (GIT_DIRECTORY_PATH.test(relativePath)) {
			continue;
		}
		try {
			const resolvedPath =
				await defaultWorkspaceSandbox.resolveExistingPath(relativePath);
			const result = await statFile(resolvedPath);
			if (result.isFile()) {
				candidates.push({ mtimeMs: result.mtimeMs, path: relativePath });
			}
		} catch {
			// A file can disappear or become inaccessible between discovery and stat.
		}
	}
	return candidates.toSorted(compareCandidates);
};

export const createGlobRunner =
	({ search = runRipgrepGlob, statFile = stat }: GlobRunnerDeps = {}) =>
	async (
		input: GlobInput,
		options: GlobToolOptions = {}
	): Promise<GlobOutput> => {
		const limits = options.resourceLimits ?? getToolResourceLimits();
		const searchInput = await resolveSearchInput(input, limits);
		const result = await search(searchInput);
		const candidatePaths = result.paths.slice(0, limits.glob.maxCandidates);
		const candidateTruncated =
			result.truncated === true ||
			result.paths.length > limits.glob.maxCandidates;
		const candidates = await collectStatCandidates(candidatePaths, statFile);
		const limit = Math.min(input.limit ?? GLOB_DEFAULT_LIMIT, GLOB_MAX_LIMIT);
		const truncated = candidateTruncated || candidates.length > limit;
		const output: GlobOutput = { paths: [] };

		for (const candidate of candidates) {
			if (output.paths.length >= limit) {
				break;
			}
			output.paths.push(candidate.path);
			const candidateOutput = truncated
				? { paths: output.paths, truncated: true }
				: { paths: output.paths };
			if (!fitsSerializedBytes(candidateOutput, limits.glob.maxOutputBytes)) {
				output.paths.pop();
				return { paths: output.paths, truncated: true };
			}
		}

		if (truncated) {
			output.truncated = true;
		}
		return output;
	};

export const runGlobTool = createGlobRunner();
