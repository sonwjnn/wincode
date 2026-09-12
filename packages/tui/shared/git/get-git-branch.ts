type BunSpawn = (
	command: string[],
	options: { cwd: string; stderr: "ignore"; stdout: "pipe" }
) => { exited: Promise<number>; stdout: ReadableStream<Uint8Array> };

const bunGlobal = globalThis as typeof globalThis & {
	Bun: { spawn: BunSpawn };
};

/** Resolves the current git branch for `cwd`, or `null` when it isn't a git repo (or HEAD is detached). */
export const getGitBranch = async (cwd: string): Promise<string | null> => {
	try {
		const process = bunGlobal.Bun.spawn(["git", "branch", "--show-current"], {
			cwd,
			stderr: "ignore",
			stdout: "pipe",
		});
		const exitCode = await process.exited;
		if (exitCode !== 0) {
			return null;
		}
		const branch = (await new Response(process.stdout).text()).trim();
		return branch || null;
	} catch {
		return null;
	}
};
