import { homedir } from "node:os";
import { useGitBranch } from "@/shared/git/use-git-branch";
import { useTheme } from "@/shared/providers/theme/theme-provider";

/** `/Users/me/src/app` -> `~/src/app`, so long paths stay readable in a narrow panel. */
const shortenPath = (path: string): string => {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`)
		? `~${path.slice(home.length)}`
		: path;
};

/** Current workspace as `cwd:branch`, dropping the branch outside a git repo. */
export function WorkspacePath() {
	const { colors } = useTheme();
	const cwd = process.cwd();
	const branch = useGitBranch(cwd);

	return (
		<text fg={colors.textMuted}>
			<span>{shortenPath(cwd)}</span>
			{branch ? (
				<>
					<span>:</span>
					<b>{branch}</b>
				</>
			) : null}
		</text>
	);
}
