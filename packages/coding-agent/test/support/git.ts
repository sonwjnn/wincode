import { $ } from "bun";

export const runGit = async (cwd: string, args: string[]) => {
	const result = await $`git -C ${cwd} ${args}`.quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`
		);
	}
};
