import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { WORKSPACE_IGNORED_DIRECTORY_NAMES } from "../../workspace";
import {
	RipgrepUnavailableError,
	resolveRipgrepExecutable,
} from "../grep/binary";
import { truncateUtf8 } from "../output-bounds";
import type { GlobSearchInput, GlobSearchResult } from "./backend";

export { RipgrepUnavailableError } from "../grep/binary";

const DEFAULT_GLOB_TIMEOUT_MS = 5000;
const RIPGREP_ERROR_MAX_BYTES = 8 * 1024;
const INVALID_GLOB_ERROR = /error parsing glob|invalid glob/iu;

export class RipgrepInvalidGlobPatternError extends Error {
	constructor(message: string) {
		super(
			message ? `Invalid glob pattern: ${message}` : "Invalid glob pattern."
		);
		this.name = "RipgrepInvalidGlobPatternError";
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
	error instanceof Error ? error.message : "ripgrep glob search failed";

const normalizeCandidatePath = (
	cwd: string,
	candidatePath: string
): string | undefined => {
	const resolvedPath = path.resolve(cwd, candidatePath);
	const relativePath = path
		.relative(cwd, resolvedPath)
		.split(path.sep)
		.join("/");
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith("../") ||
		path.isAbsolute(relativePath)
	) {
		return;
	}
	return relativePath;
};

export const buildRipgrepGlobArguments = (input: GlobSearchInput): string[] => {
	const args = [
		"--no-config",
		"--files",
		"--null",
		"--color=never",
		"--no-messages",
	];
	if (input.hidden) {
		args.push("--hidden");
	}
	if (!input.gitignore) {
		args.push("--no-ignore");
	}
	args.push("--glob", input.pattern);
	if (input.gitignore) {
		for (const directoryName of WORKSPACE_IGNORED_DIRECTORY_NAMES) {
			if (directoryName === ".git") {
				continue;
			}
			args.push(
				"--glob",
				`!**/${directoryName}/**`,
				"--glob",
				`!**/${directoryName}`
			);
		}
	}
	args.push("--glob", "!**/.git/**", "--glob", "!**/.git", "--", input.path);
	return args;
};

export type RipgrepGlobOptions = {
	executable?: string;
	resolveExecutable?: () => Promise<string>;
	spawnProcess?: typeof spawn;
};

export const runRipgrepGlob = async (
	input: GlobSearchInput,
	options: RipgrepGlobOptions = {}
): Promise<GlobSearchResult> => {
	const timeoutMs = input.maxDurationMs ?? DEFAULT_GLOB_TIMEOUT_MS;
	const executable =
		options.executable ??
		(await (options.resolveExecutable ?? resolveRipgrepExecutable)());
	const spawnProcess = options.spawnProcess ?? spawn;
	const { promise, resolve, reject } =
		Promise.withResolvers<GlobSearchResult>();

	let child: ChildProcess;
	try {
		child = spawnProcess(executable, buildRipgrepGlobArguments(input), {
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

	const decoder = new StringDecoder("utf8");
	const paths: string[] = [];
	let stderr = "";
	let truncated = false;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending = "";

	const terminate = (): void => {
		if (!child.killed) {
			child.kill();
		}
	};

	const cleanup = (): void => {
		clearTimeout(timer);
	};

	const resolveResult = (): void => {
		if (settled) {
			return;
		}
		settled = true;
		cleanup();
		resolve(truncated ? { paths, truncated: true } : { paths });
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

	const acceptCandidate = (candidate: string): void => {
		if (settled || truncated || candidate === "") {
			return;
		}
		const normalizedPath = normalizeCandidatePath(input.cwd, candidate);
		if (normalizedPath === undefined) {
			return;
		}
		if (paths.length >= input.maxCandidates) {
			truncated = true;
			terminate();
			return;
		}
		paths.push(normalizedPath);
		if (paths.length >= input.maxCandidates) {
			truncated = true;
			terminate();
		}
	};

	const consume = (text: string): void => {
		if (settled || truncated) {
			return;
		}
		pending += text;
		let separatorIndex = pending.indexOf("\0");
		while (separatorIndex >= 0) {
			const candidate = pending.slice(0, separatorIndex);
			pending = pending.slice(separatorIndex + 1);
			acceptCandidate(candidate);
			if (settled || truncated) {
				return;
			}
			separatorIndex = pending.indexOf("\0");
		}
	};

	const finishPending = (): void => {
		const finalText = `${pending}${decoder.end()}`;
		pending = "";
		if (finalText !== "") {
			acceptCandidate(finalText);
		}
	};

	const finish = (code: number | null): void => {
		if (settled) {
			return;
		}
		finishPending();
		if (truncated) {
			resolveResult();
			return;
		}
		if (code === 0 || code === 1) {
			resolveResult();
			return;
		}
		if (code === 2 && INVALID_GLOB_ERROR.test(stderr)) {
			rejectResult(new RipgrepInvalidGlobPatternError(stderr.trim()));
			return;
		}
		const detail = stderr.trim();
		rejectResult(
			new Error(
				detail || `ripgrep glob search failed with code ${String(code)}`
			)
		);
	};

	child.stderr.on("data", (chunk: Buffer) => {
		stderr = truncateUtf8(
			`${stderr}${chunk.toString("utf8")}`,
			RIPGREP_ERROR_MAX_BYTES
		);
	});
	child.stdout.on("data", (chunk: Buffer) => {
		consume(decoder.write(chunk));
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
		rejectResult(
			new Error(`ripgrep glob search timed out after ${timeoutMs}ms.`)
		);
	}, timeoutMs);

	return promise;
};
