import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isUndefined } from "@wincode/runtime-utils";
import { $ } from "bun";
import { keepTailUtf8 } from "../output-bounds";
import {
	getToolResourceLimits,
	type ResourceLimitOptions,
	type ToolResourceLimits,
} from "../resource-limits";
import { defaultWorkspaceSandbox } from "../workspace";
import {
	SHELL_OUTPUT_TAIL_BYTES,
	type ShellInput,
	type ShellOutput,
	type ShellPlatform,
	shellPlatformFromNode,
} from "./schema";

export const composeShellTruncationBanner = (maxOutputBytes: number): string =>
	`\n[output truncated — kept the final ${maxOutputBytes} bytes]\n`;

export const SHELL_OUTPUT_TRUNCATION_BANNER = composeShellTruncationBanner(
	SHELL_OUTPUT_TAIL_BYTES
);

export const composeShellTimeoutMessage = (timeoutSeconds: number): string =>
	`\n[command timed out after ${timeoutSeconds}s and was terminated]\n`;

/**
 * The platform-specific shell invocation the runner executes. The builder is
 * pure and injected so the PowerShell branch can be unit-tested without ever
 * touching a Windows host.
 */
export type ShellInvocation = {
	args: readonly string[];
	/** Decodes captured output as UTF-16LE when a BOM is present (PowerShell). */
	decodeUtf16Le: boolean;
	executable: string;
};

export const buildShellInvocation = (
	command: string,
	platform: ShellPlatform
): ShellInvocation =>
	platform === "win32"
		? {
				args: ["-NoProfile", "-NonInteractive", "-Command", command],
				decodeUtf16Le: true,
				executable: "powershell.exe",
			}
		: {
				args: ["-c", command],
				decodeUtf16Le: false,
				executable: "/bin/bash",
			};

/**
 * Decodes captured command output: UTF-16LE when the buffer carries a BOM and
 * the invocation expects it (Windows PowerShell), UTF-8 otherwise.
 */
export const decodeShellOutput = (
	buffer: Buffer,
	decodeUtf16Le: boolean
): string => {
	if (
		decodeUtf16Le &&
		buffer.length >= 2 &&
		buffer[0] === 0xff &&
		buffer[1] === 0xfe
	) {
		return buffer.subarray(2).toString("utf16le");
	}
	return buffer.toString("utf8");
};

const expandHomeInShellPath = (input: string): string => {
	const home = homedir();
	if (input === "~") {
		return home;
	}
	if (input.startsWith("~/")) {
		return `${home}${input.slice(1)}`;
	}
	if (input.startsWith("$HOME")) {
		return `${home}${input.slice("$HOME".length)}`;
	}
	return input;
};

const findExistingPathAncestor = (targetPath: string): string => {
	let parentPath = targetPath;
	while (!existsSync(parentPath)) {
		const nextParentPath = path.dirname(parentPath);
		if (nextParentPath === parentPath) {
			return parentPath;
		}
		parentPath = nextParentPath;
	}
	return parentPath;
};

const resolveShellCwd = async (cwd: string | undefined): Promise<string> => {
	if (isUndefined(cwd)) {
		return defaultWorkspaceSandbox.root;
	}
	const expanded = expandHomeInShellPath(cwd);
	try {
		return await defaultWorkspaceSandbox.resolveExistingPath(expanded);
	} catch {
		try {
			return await defaultWorkspaceSandbox.resolveNewPath(expanded);
		} catch {
			// The cwd was approved through the external-directory boundary, so the
			// runner resolves it against the workspace root, realpath-resolving
			// the nearest existing ancestor like the gate did — a symlink
			// retargeted after approval cannot redirect execution elsewhere.
			const resolvedPath = path.resolve(defaultWorkspaceSandbox.root, expanded);
			const existingAncestor = findExistingPathAncestor(resolvedPath);
			const realAncestor = realpathSync(existingAncestor);
			const suffix = resolvedPath.slice(existingAncestor.length);
			return `${realAncestor}${suffix}`;
		}
	}
};

export type ShellRunnerDeps = {
	buildInvocation?: typeof buildShellInvocation;
	platform?: ShellPlatform;
};

const assertShellInputWithinLimits = (
	input: ShellInput,
	limits: ToolResourceLimits
): void => {
	if (input.command.length > limits.shell.maxCommandChars) {
		throw new Error(
			`Shell command exceeds the ${limits.shell.maxCommandChars}-character limit for the ${limits.profile} resource profile.`
		);
	}
	if (!isUndefined(input.cwd) && input.cwd.length > limits.shell.maxCwdChars) {
		throw new Error(
			`Shell cwd exceeds the ${limits.shell.maxCwdChars}-character limit for the ${limits.profile} resource profile.`
		);
	}
};

const PS_LINE_FIELDS_REGEX = /\s+/;
const PS_OUTPUT_MAX_BYTES = 1024 * 1024;

/**
 * Collects every descendant pid of `rootPid` from the process table, so a
 * finished or timed-out command's background children can be terminated even
 * when their output was redirected away from the captured pipes. The walk is
 * defensive: a missing `ps`, a race, or an unreadable table just kills nothing
 * extra rather than failing the tool call.
 */
const listDescendantPids = async (rootPid: number): Promise<number[]> => {
	const childrenByParent = new Map<number, number[]>();
	let outputBytes = 0;
	let exceededOutputLimit = false;
	try {
		for await (const line of $`ps -axo pid=,ppid=`.lines()) {
			outputBytes += Buffer.byteLength(line, "utf8") + 1;
			if (outputBytes > PS_OUTPUT_MAX_BYTES) {
				exceededOutputLimit = true;
				continue;
			}
			const [pidText, ppidText] = line.trim().split(PS_LINE_FIELDS_REGEX);
			const pid = Number(pidText);
			const ppid = Number(ppidText);
			if (!(Number.isInteger(pid) && Number.isInteger(ppid))) {
				continue;
			}
			const siblings = childrenByParent.get(ppid) ?? [];
			siblings.push(pid);
			childrenByParent.set(ppid, siblings);
		}
	} catch {
		return [];
	}
	if (exceededOutputLimit) {
		return [];
	}

	const descendants: number[] = [];
	const queue = [rootPid];
	let cursor = 0;
	while (cursor < queue.length) {
		const pid = queue[cursor];
		cursor += 1;
		if (isUndefined(pid)) {
			continue;
		}
		for (const childPid of childrenByParent.get(pid) ?? []) {
			descendants.push(childPid);
			queue.push(childPid);
		}
	}
	return descendants;
};

const killProcessTree = async (
	child: Bun.Subprocess,
	platform: ShellPlatform,
	force: boolean
): Promise<void> => {
	if (platform === "win32") {
		try {
			const killer = Bun.spawn(
				["taskkill", "/pid", String(child.pid), "/T", "/F"],
				{ stdin: "ignore", stdout: "ignore", stderr: "ignore" }
			);
			void killer.exited.catch(() => undefined);
		} catch {
			// The process is already gone; nothing to terminate.
		}
		return;
	}
	// Kill the process group first: while the command's shell is still alive
	// this reaches the whole tree in one call.
	try {
		process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
	} catch {
		// The group is already gone; fall through to the table walk.
	}
	// Background children whose output was redirected away from the captured
	// pipes can outlive both the shell and its process group; walk the process
	// table and terminate every descendant, deepest first.
	const descendants = await listDescendantPids(child.pid);
	for (const pid of descendants.toReversed()) {
		try {
			process.kill(pid, force ? "SIGKILL" : "SIGTERM");
		} catch {
			// The descendant is already gone.
		}
	}
};

/**
 * Builds the bounded model-visible result from the captured output: the active
 * profile's output budget with a truncation banner, plus the timeout note when
 * the command was killed.
 */
const composeShellOutput = (
	rawOutput: string,
	timedOut: boolean,
	timeoutSeconds: number,
	maxOutputBytes: number
): { output: string; truncated?: boolean } => {
	if (Buffer.byteLength(rawOutput, "utf8") <= maxOutputBytes) {
		return {
			output: timedOut
				? `${rawOutput}${composeShellTimeoutMessage(timeoutSeconds)}`
				: rawOutput,
		};
	}
	const output = `${composeShellTruncationBanner(maxOutputBytes)}${keepTailUtf8(
		rawOutput,
		maxOutputBytes
	)}${timedOut ? composeShellTimeoutMessage(timeoutSeconds) : ""}`;
	return { output, truncated: true };
};

/** How long after the main process exits the runner waits for trailing output. */
const OUTPUT_DRAIN_MS = 100;

export type ShellRunnerOptions = ResourceLimitOptions & {
	signal?: AbortSignal;
};

/**
 * Executes a bounded shell command: no stdin, inherited environment, process
 * tree killed on completion and on timeout, merged stdout+stderr output kept
 * to the active resource profile's tail with a truncation banner. The platform
 * builder is injected so tests can pin the PowerShell branch without a Windows
 * host; every other execution primitive is real.
 */

export const createShellRunner = (
	deps: ShellRunnerDeps = {}
): ((
	input: ShellInput,
	options?: ShellRunnerOptions
) => Promise<ShellOutput>) => {
	const buildInvocation = deps.buildInvocation ?? buildShellInvocation;
	const platform = deps.platform ?? shellPlatformFromNode(process.platform);

	return async (
		input: ShellInput,
		options: ShellRunnerOptions = {}
	): Promise<ShellOutput> => {
		const limits = options.resourceLimits ?? getToolResourceLimits();
		assertShellInputWithinLimits(input, limits);
		const invocation = buildInvocation(input.command, platform);
		const cwd = await resolveShellCwd(input.cwd);
		const timeoutSeconds = Math.min(
			input.timeout ?? limits.shell.defaultTimeoutSeconds,
			limits.shell.maxTimeoutSeconds
		);
		// Keep at most twice the active profile's model-visible output budget in
		// memory; older bytes are dropped as new ones arrive.
		const maxBufferedOutputBytes = limits.shell.maxOutputBytes * 2;

		const { promise, resolve, reject } = Promise.withResolvers<ShellOutput>();
		let retainedOutput: Buffer = Buffer.alloc(0);
		let timedOut = false;
		let settled = false;
		let processExited = false;
		let stdoutDone = false;
		let stderrDone = false;
		let exitCode: number | null = null;
		let aborted = false;

		let child: Bun.Subprocess;
		try {
			child = Bun.spawn([invocation.executable, ...invocation.args], {
				cwd,
				detached: platform === "posix",
				env: process.env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
		} catch (error) {
			reject(error);
			return promise;
		}
		const stdout = child.stdout;
		const stderr = child.stderr;
		if (
			stdout === null ||
			stdout === undefined ||
			typeof stdout === "number" ||
			stderr === null ||
			stderr === undefined ||
			typeof stderr === "number"
		) {
			child.kill();
			reject(new Error("Shell process did not expose output streams."));
			return promise;
		}
		const stdoutReader = stdout.getReader();
		const stderrReader = stderr.getReader();

		const collect = (chunk: Uint8Array): void => {
			const buffer = Buffer.from(
				chunk.buffer,
				chunk.byteOffset,
				chunk.byteLength
			);
			if (buffer.length >= maxBufferedOutputBytes) {
				retainedOutput = buffer.subarray(
					buffer.length - maxBufferedOutputBytes
				);
				return;
			}
			if (retainedOutput.length + buffer.length <= maxBufferedOutputBytes) {
				retainedOutput = Buffer.concat([retainedOutput, buffer]);
				return;
			}
			retainedOutput = Buffer.concat([retainedOutput, buffer]).subarray(
				retainedOutput.length + buffer.length - maxBufferedOutputBytes
			);
		};

		const timer = setTimeout(() => {
			timedOut = true;
			void killProcessTree(child, platform, true);
		}, timeoutSeconds * 1000);

		let drainTimer: Timer | undefined;

		const cancelReaders = (): void => {
			if (!stdoutDone) {
				void stdoutReader.cancel().catch(() => undefined);
			}
			if (!stderrDone) {
				void stderrReader.cancel().catch(() => undefined);
			}
		};

		const fail = (error: unknown): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			clearTimeout(drainTimer);
			options.signal?.removeEventListener("abort", onAbort);
			cancelReaders();
			reject(error);
		};

		const settle = async (): Promise<void> => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			clearTimeout(drainTimer);
			options.signal?.removeEventListener("abort", onAbort);
			await killProcessTree(child, platform, timedOut || aborted);
			cancelReaders();
			const rawOutput = decodeShellOutput(
				retainedOutput,
				invocation.decodeUtf16Le
			);
			const { output, truncated } = composeShellOutput(
				rawOutput,
				timedOut,
				timeoutSeconds,
				limits.shell.maxOutputBytes
			);
			resolve({
				exitCode: aborted || timedOut ? null : exitCode,
				output,
				...(timedOut ? { timedOut: true } : {}),
				...(truncated === true ? { truncated: true } : {}),
			});
		};

		const scheduleDrain = (): void => {
			if (!isUndefined(drainTimer)) {
				return;
			}
			drainTimer = setTimeout(() => {
				void settle();
			}, OUTPUT_DRAIN_MS);
		};

		const onAbort = (): void => {
			if (settled) {
				return;
			}
			aborted = true;
			void killProcessTree(child, platform, true);
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) {
			onAbort();
		}

		const finishReader = (reader: typeof stdoutReader): void => {
			reader.releaseLock();
			if (reader === stdoutReader) {
				stdoutDone = true;
			} else {
				stderrDone = true;
			}
			if (processExited && stdoutDone && stderrDone) {
				void settle();
			}
		};
		const consume = async (reader: typeof stdoutReader): Promise<void> => {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					if (!settled) {
						collect(value);
					}
				}
			} catch (error) {
				fail(error);
			} finally {
				finishReader(reader);
			}
		};

		void consume(stdoutReader);
		void consume(stderrReader);
		void child.exited.then((code) => {
			exitCode = child.signalCode === null ? code : null;
			processExited = true;
			if (stdoutDone && stderrDone) {
				void settle();
				return;
			}
			scheduleDrain();
		}, fail);
		return promise;
	};
};

export const runShellTool = createShellRunner();
