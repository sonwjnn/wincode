import path from "node:path";
import {
	getErrorMessage,
	isError,
	isObjectLike,
	isPlainObject,
	isString,
} from "@wincode/runtime-utils";
import type { UnknownRecord } from "type-fest";
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
const LINE_BREAK = /[\r\n]/u;
const INVALID_PATTERN_ERROR = /regex parse error|error parsing regex/iu;

export { RipgrepUnavailableError } from "./binary";

export class RipgrepInvalidPatternError extends Error {
	constructor(message: string) {
		super(message || "Invalid grep pattern.");
		this.name = "RipgrepInvalidPatternError";
	}
}

const getErrorCode = (error: unknown): string | undefined => {
	if (!(isObjectLike(error) && "code" in error)) {
		return;
	}
	const code = error.code;
	return isString(code) ? code : undefined;
};

const asRecord = (value: unknown): UnknownRecord | undefined =>
	isPlainObject(value) ? value : undefined;

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
		!(isString(matchPath) && isString(lineText)) ||
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

type RipgrepSearchOptions = {
	executable?: string;
	resolveExecutable?: () => Promise<string>;
	spawnProcess?: RipgrepSpawnProcess;
};

export const runRipgrepSearch: GrepSearch = async (
	input: GrepSearchInput,
	options: RipgrepSearchOptions = {}
): Promise<GrepSearchResult> => {
	const timeoutMs = input.maxDurationMs ?? DEFAULT_RIPGREP_TIMEOUT_MS;
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
		Promise.withResolvers<GrepSearchResult>();

	let child: Bun.Subprocess;
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
		reject(
			isError(error)
				? error
				: new Error(getErrorMessage(error, "ripgrep search failed"))
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
	const matches: GrepSearchMatch[] = [];
	const matchedPaths = new Set<string>();
	let stderr = "";
	let truncated = false;
	let settled = false;
	let processExited = false;
	let stdoutDone = false;
	let stderrDone = false;
	let exitCode: number | null = null;
	let timer: Timer | undefined;
	let pending = "";
	const isFinished = (): boolean => settled || truncated;

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
		resolve(truncated ? { matches, truncated: true } : { matches });
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
				: new Error(getErrorMessage(error, "ripgrep search failed"))
		);
	};

	const handleLine = (line: string): void => {
		if (isFinished()) {
			return;
		}
		if (Buffer.byteLength(line, "utf8") > RIPGREP_RECORD_MAX_BYTES) {
			pending = "";
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
			pending = "";
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
			pending = "";
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
			pending = "";
			terminate();
		}
	};

	const consumeText = (text: string, final = false): void => {
		if (isFinished()) {
			return;
		}
		pending += text;
		let lineBreak = pending.search(LINE_BREAK);
		while (lineBreak >= 0) {
			const separator = pending[lineBreak];
			if (separator === "\r" && lineBreak === pending.length - 1 && !final) {
				break;
			}
			const line = pending.slice(0, lineBreak);
			const separatorLength =
				separator === "\r" && pending[lineBreak + 1] === "\n" ? 2 : 1;
			pending = pending.slice(lineBreak + separatorLength);
			handleLine(line);
			if (isFinished()) {
				pending = "";
				return;
			}
			lineBreak = pending.search(LINE_BREAK);
		}
		const lineFragment = pending.endsWith("\r")
			? pending.slice(0, -1)
			: pending;
		if (Buffer.byteLength(lineFragment, "utf8") > RIPGREP_RECORD_MAX_BYTES) {
			pending = "";
			rejectResult(
				new Error(
					`Ripgrep JSON record exceeded ${RIPGREP_RECORD_MAX_BYTES} bytes.`
				)
			);
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
		if (code === 2 && INVALID_PATTERN_ERROR.test(stderr)) {
			rejectResult(new RipgrepInvalidPatternError(stderr.trim()));
			return;
		}

		const detail = stderr.trim();
		rejectResult(
			new Error(detail || `ripgrep search failed with code ${String(code)}`)
		);
	};

	const maybeFinish = (): void => {
		if (processExited && stdoutDone && stderrDone) {
			finish(exitCode);
		}
	};

	timer = setTimeout(() => {
		rejectResult(new Error(`ripgrep search timed out after ${timeoutMs}ms.`));
	}, timeoutMs);

	void (async () => {
		try {
			while (true) {
				const { done, value } = await stdoutReader.read();
				if (done) {
					break;
				}
				consumeText(decoder.decode(value, { stream: true }));
			}
			consumeText(decoder.decode(), true);
			if (!(settled || truncated) && pending !== "") {
				const finalLine = pending;
				pending = "";
				handleLine(finalLine);
			}
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
