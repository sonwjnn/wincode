import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { defaultWorkspaceSandbox } from "../../workspace";
import { keepTailUtf8 } from "../output-bounds";
import {
	SHELL_OUTPUT_TAIL_BYTES,
	SHELL_TIMEOUT_DEFAULT_SECONDS,
	SHELL_TIMEOUT_MAX_SECONDS,
	type ShellInput,
	type ShellOutput,
	type ShellPlatform,
	shellPlatformFromNode,
} from "./schema";

const runPs = promisify(execFile);

export const SHELL_OUTPUT_TRUNCATION_BANNER = `\n[output truncated — kept the final ${SHELL_OUTPUT_TAIL_BYTES} bytes]\n`;

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
	if (cwd === undefined) {
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

const PS_LINE_FIELDS_REGEX = /\s+/;

/**
 * Collects every descendant pid of `rootPid` from the process table, so a
 * finished or timed-out command's background children can be terminated even
 * when their output was redirected away from the captured pipes. The walk is
 * defensive: a missing `ps`, a race, or an unreadable table just kills nothing
 * extra rather than failing the tool call.
 */
const listDescendantPids = async (rootPid: number): Promise<number[]> => {
	let stdout: string;
	try {
		({ stdout } = await runPs("ps", ["-axo", "pid=,ppid="], {
			encoding: "utf8",
		}));
	} catch {
		return [];
	}
	const childrenByParent = new Map<number, number[]>();
	for (const line of stdout.split("\n")) {
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
	const descendants: number[] = [];
	const queue = [rootPid];
	let cursor = 0;
	while (cursor < queue.length) {
		const pid = queue[cursor];
		cursor += 1;
		if (pid === undefined) {
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
	child: ChildProcess,
	platform: ShellPlatform,
	force: boolean
): Promise<void> => {
	if (platform === "win32") {
		if (child.pid === undefined) {
			return;
		}
		try {
			const killer = spawn(
				"taskkill",
				["/pid", String(child.pid), "/T", "/F"],
				{ stdio: "ignore" }
			);
			killer.on("error", () => undefined);
		} catch {
			// The process is already gone; nothing to terminate.
		}
		return;
	}
	// Kill the process group first: while the command's shell is still alive
	// this reaches the whole tree in one call.
	if (child.pid !== undefined) {
		try {
			process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
		} catch {
			// The group is already gone; fall through to the table walk.
		}
	}
	// Background children whose output was redirected away from the captured
	// pipes can outlive both the shell and its process group; walk the process
	// table and terminate every descendant, deepest first.
	if (child.pid === undefined) {
		return;
	}
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
 * Builds the bounded model-visible result from the captured output: the final
 * 30 KiB with a truncation banner, plus the timeout note when the command was
 * killed.
 */
const composeShellOutput = (
	rawOutput: string,
	timedOut: boolean,
	timeoutSeconds: number
): { output: string; truncated?: boolean } => {
	if (Buffer.byteLength(rawOutput, "utf8") <= SHELL_OUTPUT_TAIL_BYTES) {
		return {
			output: timedOut
				? `${rawOutput}${composeShellTimeoutMessage(timeoutSeconds)}`
				: rawOutput,
		};
	}
	const output = `${SHELL_OUTPUT_TRUNCATION_BANNER}${keepTailUtf8(
		rawOutput,
		SHELL_OUTPUT_TAIL_BYTES
	)}${timedOut ? composeShellTimeoutMessage(timeoutSeconds) : ""}`;
	return { output, truncated: true };
};

/**
 * The runner keeps at most this much captured output in memory (twice the
 * model-visible tail) so a chatty command within a long timeout cannot balloon
 * the CLI's memory; older bytes are dropped as new ones arrive.
 */
const MAX_BUFFERED_OUTPUT_BYTES = SHELL_OUTPUT_TAIL_BYTES * 2;

/** How long after the main process exits the runner waits for trailing output. */
const OUTPUT_DRAIN_MS = 100;

/**
 * Executes a bounded shell command: no stdin, inherited environment, process
 * tree killed on completion and on timeout, merged stdout+stderr output kept
 * to its final 30 KiB with a model-visible truncation banner. The platform
 * builder is injected so tests can pin the PowerShell branch without a
 * Windows host; every other execution primitive is real.
 */
export const createShellRunner = (
	deps: ShellRunnerDeps = {}
): ((input: ShellInput) => Promise<ShellOutput>) => {
	const buildInvocation = deps.buildInvocation ?? buildShellInvocation;
	const platform = deps.platform ?? shellPlatformFromNode(process.platform);

	return async (input: ShellInput): Promise<ShellOutput> => {
		const invocation = buildInvocation(input.command, platform);
		const cwd = await resolveShellCwd(input.cwd);
		const timeoutSeconds = Math.min(
			input.timeout ?? SHELL_TIMEOUT_DEFAULT_SECONDS,
			SHELL_TIMEOUT_MAX_SECONDS
		);

		return await new Promise<ShellOutput>((resolve, reject) => {
			let retainedOutput: Buffer = Buffer.alloc(0);
			let timedOut = false;
			let settled = false;
			let exitCode: number | null = null;

			const child = spawn(invocation.executable, [...invocation.args], {
				cwd,
				detached: platform === "posix",
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});

			const collect = (chunk: Buffer): void => {
				if (chunk.length >= MAX_BUFFERED_OUTPUT_BYTES) {
					retainedOutput = chunk.subarray(
						chunk.length - MAX_BUFFERED_OUTPUT_BYTES
					);
					return;
				}
				if (retainedOutput.length + chunk.length <= MAX_BUFFERED_OUTPUT_BYTES) {
					retainedOutput = Buffer.concat([retainedOutput, chunk]);
					return;
				}
				retainedOutput = Buffer.concat([retainedOutput, chunk]).subarray(
					retainedOutput.length + chunk.length - MAX_BUFFERED_OUTPUT_BYTES
				);
			};

			const timer = setTimeout(() => {
				timedOut = true;
				void killProcessTree(child, platform, true);
			}, timeoutSeconds * 1000);

			// The drain timer bounds the wait between the main process exiting
			// and the pipes closing: a background child that keeps a pipe open
			// must not stall the tool call until the timeout.
			let drainTimer: ReturnType<typeof setTimeout> | undefined;

			const settle = async (): Promise<void> => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				if (drainTimer !== undefined) {
					clearTimeout(drainTimer);
				}
				await killProcessTree(child, platform, timedOut);
				const rawOutput = decodeShellOutput(
					retainedOutput,
					invocation.decodeUtf16Le
				);
				const { output, truncated } = composeShellOutput(
					rawOutput,
					timedOut,
					timeoutSeconds
				);
				resolve({
					exitCode: timedOut ? null : exitCode,
					output,
					...(timedOut ? { timedOut: true } : {}),
					...(truncated === true ? { truncated: true } : {}),
				});
			};

			const scheduleDrain = (): void => {
				if (drainTimer !== undefined) {
					return;
				}
				drainTimer = setTimeout(() => {
					void settle();
				}, OUTPUT_DRAIN_MS);
			};

			child.stdout.on("data", collect);
			child.stderr.on("data", collect);
			child.on("error", (error) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					if (drainTimer !== undefined) {
						clearTimeout(drainTimer);
					}
					reject(error);
				}
			});
			// `exit` fires when the main process exits; `close` follows once the
			// captured pipes drain. If a background child holds a pipe open, the
			// drain timer settles the call anyway and kills the tree.
			child.on("exit", (code) => {
				exitCode = code;
				scheduleDrain();
			});
			child.on("close", (code) => {
				exitCode = code;
				void settle();
			});
		});
	};
};

export const runShellTool = createShellRunner();
