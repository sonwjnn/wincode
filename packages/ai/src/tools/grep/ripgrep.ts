import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { truncateUtf8 } from "../output-bounds";
import { getToolResourceLimits } from "../resource-limits";
import type {
	GrepSearch,
	GrepSearchInput,
	GrepSearchMatch,
	GrepSearchResult,
} from "./backend";
import { RipgrepUnavailableError, resolveRipgrepExecutable } from "./binary";

const DEFAULT_RIPGREP_TIMEOUT_MS = getToolResourceLimits().grep.maxDurationMs;
const RIPGREP_ERROR_MAX_BYTES = 8 * 1024;
const RIPGREP_RECORD_MAX_BYTES = 64 * 1024;
const LINE_ENDING = /\r?\n$/u;
const INVALID_PATTERN_ERROR = /regex parse error|error parsing regex/iu;

export { RipgrepUnavailableError } from "./binary";

export class RipgrepInvalidPatternError extends Error {
	constructor(message: string) {
		super(message || "Invalid grep pattern.");
		this.name = "RipgrepInvalidPatternError";
	}
}

const getErrorCode = (error: unknown): string | undefined => {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return;
	}
	const code = error.code;
	return typeof code === "string" ? code : undefined;
};

const getErrorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : "ripgrep search failed";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

const normalizeMatchPath = (cwd: string, matchPath: string): string =>
	path
		.relative(
			cwd,
			path.isAbsolute(matchPath) ? matchPath : path.resolve(cwd, matchPath)
		)
		.split(path.sep)
		.join("/");

const parseRipgrepMatch = (line: string): GrepSearchMatch | undefined => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new Error("Invalid ripgrep JSON output.");
	}

	const record = asRecord(parsed);
	if (!record) {
		throw new Error("Invalid ripgrep JSON output.");
	}
	if (record.type !== "match") {
		return;
	}

	const data = asRecord(record.data);
	const matchPath = asRecord(data?.path)?.text;
	const lineText = asRecord(data?.lines)?.text;
	const lineNumber = data?.line_number;
	if (
		typeof matchPath !== "string" ||
		typeof lineText !== "string" ||
		typeof lineNumber !== "number" ||
		!Number.isInteger(lineNumber) ||
		lineNumber < 1
	) {
		throw new Error("Invalid ripgrep match output.");
	}

	return {
		line: lineText.replace(LINE_ENDING, ""),
		lineNumber,
		path: matchPath,
	};
};

export const buildRipgrepArguments = (input: GrepSearchInput): string[] => {
	const args = [
		"--no-config",
		"--json",
		"--color=never",
		"--line-number",
		"--hidden",
		"--no-ignore",
		"--no-messages",
		"--max-depth",
		String(input.maxDepth),
		"--max-filesize",
		String(input.maxFileBytes),
		"--sort",
		"path",
	];

	for (const directoryName of input.ignoredDirectoryNames) {
		args.push("--glob", `!**/${directoryName}/**`);
	}

	args.push("--", input.pattern, input.path);
	return args;
};

type RipgrepSearchOptions = {
	executable?: string;
	resolveExecutable?: () => Promise<string>;
	spawnProcess?: typeof spawn;
};

export const runRipgrepSearch: GrepSearch = async (
	input: GrepSearchInput,
	options: RipgrepSearchOptions = {}
): Promise<GrepSearchResult> => {
	const timeoutMs = input.maxDurationMs ?? DEFAULT_RIPGREP_TIMEOUT_MS;
	const executable =
		options.executable ??
		(await (options.resolveExecutable ?? resolveRipgrepExecutable)());
	const spawnProcess = options.spawnProcess ?? spawn;
	const { promise, resolve, reject } =
		Promise.withResolvers<GrepSearchResult>();

	let child: ReturnType<typeof spawn>;
	try {
		child = spawnProcess(executable, buildRipgrepArguments(input), {
			cwd: input.cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") {
			reject(new RipgrepUnavailableError(executable));
			return promise;
		}
		reject(error instanceof Error ? error : new Error(getErrorMessage(error)));
		return promise;
	}

	if (child.stdout === null || child.stderr === null) {
		child.kill();
		reject(new Error("ripgrep did not expose output streams."));
		return promise;
	}

	const lines = createInterface({ input: child.stdout });
	const matches: GrepSearchMatch[] = [];
	const matchedPaths = new Set<string>();
	let stderr = "";
	let truncated = false;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const terminate = (): void => {
		if (!child.killed) {
			child.kill();
		}
	};

	const cleanup = (): void => {
		clearTimeout(timer);
		lines.close();
	};

	const resolveResult = (): void => {
		if (settled) {
			return;
		}
		settled = true;
		cleanup();
		resolve(truncated ? { matches, truncated: true } : { matches });
	};

	const rejectResult = (error: unknown): void => {
		if (settled) {
			return;
		}
		settled = true;
		cleanup();
		terminate();
		reject(error instanceof Error ? error : new Error(getErrorMessage(error)));
	};

	const finish = (code: number | null): void => {
		if (settled) {
			return;
		}
		if (truncated) {
			resolveResult();
			return;
		}
		if (code === 0 || code === 1) {
			resolveResult();
			return;
		}
		if (code === 2 && INVALID_PATTERN_ERROR.test(stderr)) {
			rejectResult(new RipgrepInvalidPatternError(stderr.trim()));
			return;
		}

		const detail = stderr.trim();
		rejectResult(
			new Error(detail || `ripgrep search failed with code ${String(code)}`)
		);
	};

	child.stderr.on("data", (chunk: Buffer) => {
		stderr = truncateUtf8(
			`${stderr}${chunk.toString("utf8")}`,
			RIPGREP_ERROR_MAX_BYTES
		);
	});

	lines.on("line", (line) => {
		if (settled || truncated) {
			return;
		}
		if (Buffer.byteLength(line, "utf8") > RIPGREP_RECORD_MAX_BYTES) {
			rejectResult(
				new Error(
					`Ripgrep JSON record exceeded ${RIPGREP_RECORD_MAX_BYTES} bytes.`
				)
			);
			return;
		}

		let match: GrepSearchMatch | undefined;
		try {
			match = parseRipgrepMatch(line);
		} catch (error) {
			rejectResult(error);
			return;
		}
		if (!match) {
			return;
		}

		const normalizedPath = normalizeMatchPath(input.cwd, match.path);
		if (
			!matchedPaths.has(normalizedPath) &&
			matchedPaths.size >= input.maxFiles
		) {
			truncated = true;
			terminate();
			return;
		}
		matchedPaths.add(normalizedPath);
		matches.push({
			line: truncateUtf8(match.line, input.maxLineBytes),
			lineNumber: match.lineNumber,
			path: normalizedPath,
		});
		if (matches.length >= input.maxMatches) {
			truncated = true;
			terminate();
		}
	});

	child.on("error", (error) => {
		if (getErrorCode(error) === "ENOENT") {
			rejectResult(new RipgrepUnavailableError(executable));
			return;
		}
		rejectResult(error);
	});
	child.on("close", finish);

	timer = setTimeout(() => {
		rejectResult(new Error(`ripgrep search timed out after ${timeoutMs}ms.`));
	}, timeoutMs);

	return promise;
};
