import path from "node:path";
import {
	getErrorMessage,
	isError,
	isObjectLike,
	isString,
	isUndefined,
} from "@wincode/runtime-utils";
import {
	RipgrepUnavailableError,
	resolveRipgrepExecutable,
} from "../grep/binary";
import { truncateUtf8 } from "../output-bounds";
import { WORKSPACE_IGNORED_DIRECTORY_NAMES } from "../workspace";
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
	if (!(isObjectLike(error) && "code" in error)) {
		return;
	}
	const code = error.code;
	return isString(code) ? code : undefined;
};

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
	if (input.includeHidden) {
		args.push("--hidden");
	}
	if (input.includeIgnored) {
		args.push("--no-ignore");
	}
	args.push("--glob", input.pattern);
	if (!input.includeIgnored) {
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

type RipgrepSpawnOptions = {
	cwd: string;
	env: NodeJS.ProcessEnv;
	stdio: ["ignore", "pipe", "pipe"];
	windowsHide: true;
};

type RipgrepSpawnProcess = (
	executable: string,
	args: string[],
	options: RipgrepSpawnOptions
) => Bun.Subprocess;

export type RipgrepGlobOptions = {
	executable?: string;
	resolveExecutable?: () => Promise<string>;
	spawnProcess?: RipgrepSpawnProcess;
};

export const runRipgrepGlob = async (
	input: GlobSearchInput,
	options: RipgrepGlobOptions = {}
): Promise<GlobSearchResult> => {
	const timeoutMs = input.maxDurationMs ?? DEFAULT_GLOB_TIMEOUT_MS;
	const executable =
		options.executable ??
		(await (options.resolveExecutable ?? resolveRipgrepExecutable)());
	const spawnProcess: RipgrepSpawnProcess =
		options.spawnProcess ??
		((command, args, spawnOptions) =>
			globalThis.Bun.spawn([command, ...args], {
				cwd: spawnOptions.cwd,
				env: spawnOptions.env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: spawnOptions.windowsHide,
			}));
	const { promise, resolve, reject } =
		Promise.withResolvers<GlobSearchResult>();

	let child: Bun.Subprocess;
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
		reject(
			isError(error)
				? error
				: new Error(getErrorMessage(error, "ripgrep glob search failed"))
		);
		return promise;
	}

	const stdout = child.stdout;
	const stderrStream = child.stderr;
	if (
		stdout === null ||
		stdout === undefined ||
		typeof stdout === "number" ||
		stderrStream === null ||
		stderrStream === undefined ||
		typeof stderrStream === "number"
	) {
		child.kill();
		reject(new Error("ripgrep did not expose output streams."));
		return promise;
	}

	const stdoutReader = stdout.getReader();
	const stderrReader = stderrStream.getReader();
	const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	const stderrDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
	const paths: string[] = [];
	let stderr = "";
	let truncated = false;
	let settled = false;
	let processExited = false;
	let stdoutDone = false;
	let stderrDone = false;
	let exitCode: number | null = null;
	let timer: Timer | undefined;
	let pending = "";

	const terminate = (): void => {
		if (!child.killed) {
			child.kill();
		}
	};

	const cancelReaders = (): void => {
		void stdoutReader.cancel().catch(() => undefined);
		void stderrReader.cancel().catch(() => undefined);
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
		cancelReaders();
		reject(
			isError(error)
				? error
				: new Error(getErrorMessage(error, "ripgrep glob search failed"))
		);
	};

	const acceptCandidate = (candidate: string): void => {
		if (settled || truncated || candidate === "") {
			return;
		}
		const normalizedPath = normalizeCandidatePath(input.cwd, candidate);
		if (isUndefined(normalizedPath)) {
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
		const finalText = pending;
		pending = "";
		if (finalText !== "") {
			acceptCandidate(finalText);
		}
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

	const maybeFinish = (): void => {
		if (processExited && stdoutDone && stderrDone) {
			finish(exitCode);
		}
	};

	timer = setTimeout(() => {
		rejectResult(
			new Error(`ripgrep glob search timed out after ${timeoutMs}ms.`)
		);
	}, timeoutMs);

	void (async () => {
		try {
			while (true) {
				const { done, value } = await stdoutReader.read();
				if (done) {
					break;
				}
				consume(decoder.decode(value, { stream: true }));
			}
			consume(decoder.decode());
			finishPending();
			stdoutDone = true;
			maybeFinish();
		} catch (error) {
			rejectResult(error);
		}
	})();

	void (async () => {
		try {
			while (true) {
				const { done, value } = await stderrReader.read();
				if (done) {
					break;
				}
				stderr = truncateUtf8(
					`${stderr}${stderrDecoder.decode(value, { stream: true })}`,
					RIPGREP_ERROR_MAX_BYTES
				);
			}
			stderr = truncateUtf8(
				`${stderr}${stderrDecoder.decode()}`,
				RIPGREP_ERROR_MAX_BYTES
			);
			stderrDone = true;
			maybeFinish();
		} catch (error) {
			rejectResult(error);
		}
	})();

	void child.exited.then(
		(code) => {
			exitCode = child.signalCode === null ? code : null;
			processExited = true;
			maybeFinish();
		},
		(error: unknown) => {
			rejectResult(
				getErrorCode(error) === "ENOENT"
					? new RipgrepUnavailableError(executable)
					: error
			);
		}
	);

	return promise;
};
