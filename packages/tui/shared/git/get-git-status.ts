type BunSpawnProcess = {
	exited: Promise<number>;
	kill?: (signal?: number) => void;
	stdout: ReadableStream<Uint8Array>;
};

type BunSpawn = (
	command: readonly string[],
	options: { cwd: string; stderr: "ignore"; stdout: "pipe" }
) => BunSpawnProcess;

type GitStatusCounts = {
	changedFiles: number;
	conflicted: number;
	staged: number;
	untracked: number;
	unstaged: number;
};

export type GitStatusSummary = GitStatusCounts & {
	readonly state: "clean" | "dirty" | "unavailable";
	readonly truncated: boolean;
};
const GIT_STATUS_MAX_BYTES = 16 * 1024;
const GIT_STATUS_MAX_LINES = 256;
const GIT_COMMAND_TIMEOUT_MS = 5000;
const GIT_HARD_KILL_SIGNAL = 9;

const bunGlobal = globalThis as typeof globalThis & {
	Bun?: { spawn: BunSpawn };
};
type CancelReader = () => Promise<void>;

const readBounded = async (
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
	registerCancel?: (cancel: CancelReader) => void
): Promise<{ bytes: Uint8Array; truncated: boolean }> => {
	const reader = stream.getReader();
	const cancelReader = async (): Promise<void> => {
		await reader.cancel().catch(() => undefined);
	};
	registerCancel?.(cancelReader);
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	let truncated = false;
	try {
		while (byteLength < maxBytes) {
			const result = await reader.read();
			if (result.done) {
				break;
			}
			const remaining = maxBytes - byteLength;
			const chunk = result.value;
			if (chunk.byteLength > remaining) {
				chunks.push(chunk.slice(0, remaining));
				byteLength += remaining;
				truncated = true;
				await cancelReader();
				break;
			}
			chunks.push(chunk);
			byteLength += chunk.byteLength;
		}
		if (!truncated && byteLength === maxBytes) {
			const result = await reader.read();
			if (!result.done) {
				truncated = true;
				await cancelReader();
			}
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, truncated };
};

const unavailableSummary = (): GitStatusSummary => ({
	changedFiles: 0,
	conflicted: 0,
	state: "unavailable",
	staged: 0,
	truncated: false,
	untracked: 0,
	unstaged: 0,
});

const emptyCounts = (): GitStatusCounts => ({
	changedFiles: 0,
	conflicted: 0,
	staged: 0,
	untracked: 0,
	unstaged: 0,
});

const isConflict = (index: string, worktree: string): boolean =>
	index === "U" ||
	worktree === "U" ||
	(index === "A" && worktree === "A") ||
	(index === "D" && worktree === "D") ||
	(index === "A" && worktree === "U") ||
	(index === "U" && worktree === "A") ||
	(index === "D" && worktree === "U") ||
	(index === "U" && worktree === "D");

const parseStatus = (output: string, truncated: boolean): GitStatusSummary => {
	const counts = emptyCounts();
	const lines = output.split("\n");
	let lineCount = 0;
	for (const line of lines) {
		if (line.length === 0) {
			continue;
		}
		lineCount += 1;
		if (lineCount > GIT_STATUS_MAX_LINES) {
			break;
		}
		const index = line[0] ?? " ";
		const worktree = line[1] ?? " ";
		counts.changedFiles += 1;
		if (index === "?" && worktree === "?") {
			counts.untracked += 1;
			continue;
		}
		if (index !== " ") {
			counts.staged += 1;
		}
		if (worktree !== " ") {
			counts.unstaged += 1;
		}
		if (isConflict(index, worktree)) {
			counts.conflicted += 1;
		}
	}
	const wasLineLimited = lineCount > GIT_STATUS_MAX_LINES;
	return {
		...counts,
		state: counts.changedFiles === 0 ? "clean" : "dirty",
		truncated: truncated || wasLineLimited,
	};
};

export type BoundedGitCommandResult = {
	readonly bytes: Uint8Array;
	readonly exitCode: number;
	readonly truncated: boolean;
};

export const runBoundedGitCommand = async (
	cwd: string,
	command: readonly string[]
): Promise<BoundedGitCommandResult | null> => {
	const spawn = bunGlobal.Bun?.spawn;
	if (spawn === undefined) {
		return null;
	}
	let child: BunSpawnProcess | undefined;
	let cancelOutput: CancelReader | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const spawned = spawn(command, { cwd, stderr: "ignore", stdout: "pipe" });
		child = spawned;
		const operation = (async (): Promise<BoundedGitCommandResult> => {
			const result = await readBounded(
				spawned.stdout,
				GIT_STATUS_MAX_BYTES,
				(cancel) => {
					cancelOutput = cancel;
				}
			);
			if (result.truncated) {
				spawned.kill?.(GIT_HARD_KILL_SIGNAL);
			}
			const exitCode = await spawned.exited;
			return { ...result, exitCode };
		})().catch(() => null);
		const timeoutResult = new Promise<null>((resolve) => {
			timeout = setTimeout(() => {
				void cancelOutput?.();
				spawned.kill?.(GIT_HARD_KILL_SIGNAL);
				resolve(null);
			}, GIT_COMMAND_TIMEOUT_MS);
		});
		const result = await Promise.race([operation, timeoutResult]);
		if (result === null) {
			await cancelOutput?.();
			spawned.kill?.(GIT_HARD_KILL_SIGNAL);
			await spawned.exited.catch(() => -1);
			await operation;
		}
		return result;
	} catch {
		await cancelOutput?.();
		if (child !== undefined) {
			child.kill?.(GIT_HARD_KILL_SIGNAL);
			await child.exited.catch(() => -1);
		}
		return null;
	} finally {
		clearTimeout(timeout);
	}
};
export const getGitStatusSummary = async (
	cwd: string
): Promise<GitStatusSummary> => {
	const result = await runBoundedGitCommand(cwd, [
		"git",
		"--no-optional-locks",
		"-c",
		"core.fsmonitor=false",
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
	]);
	if (result === null || (result.exitCode !== 0 && !result.truncated)) {
		return unavailableSummary();
	}
	return parseStatus(
		new TextDecoder("utf-8", { fatal: false }).decode(result.bytes),
		result.truncated
	);
};

export const getGitRepositoryRoot = async (
	cwd: string
): Promise<string | null> => {
	const result = await runBoundedGitCommand(cwd, [
		"git",
		"rev-parse",
		"--show-toplevel",
	]);
	if (result === null || result.exitCode !== 0) {
		return null;
	}
	const root = new TextDecoder("utf-8", { fatal: false })
		.decode(result.bytes)
		.trim();
	return root.length > 0 ? root : null;
};

export const formatGitStatusSummary = (summary: GitStatusSummary): string => {
	if (summary.state === "unavailable") {
		return "unavailable";
	}
	if (summary.state === "clean") {
		return "clean";
	}
	const details = [
		`${summary.changedFiles} changed`,
		`${summary.staged} staged`,
		`${summary.unstaged} unstaged`,
		`${summary.untracked} untracked`,
		`${summary.conflicted} conflicted`,
	];
	return `${details.join(", ")}${summary.truncated ? ", bounded" : ""}`;
};
