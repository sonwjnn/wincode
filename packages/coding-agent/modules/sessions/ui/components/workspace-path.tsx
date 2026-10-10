import { useGitBranch } from "@/shared/git/use-git-branch";
import { shortenHomePath } from "@/shared/paths/display-path";
import { useTheme } from "@/shared/providers/theme/theme-provider";

/** Current workspace as `cwd:branch`, dropping the branch outside a git repo. */
export function WorkspacePath() {
	const { colors } = useTheme();
	const cwd = process.cwd();
	const branch = useGitBranch(cwd);

	return (
		<text bg={colors.filePathBackground} fg={colors.filePath}>
			<span>{shortenHomePath(cwd)}</span>
			{branch ? (
				<>
					<span>:</span>
					<b fg={colors.success}>{branch}</b>
				</>
			) : null}
		</text>
	);
}
