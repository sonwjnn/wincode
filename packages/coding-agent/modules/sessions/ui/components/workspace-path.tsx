import * as path from "node:path";
import * as url from "node:url";
import { useEffect, useState } from "react";
import { getGitRepositoryWebUrl } from "@/shared/git/get-git-branch";
import { useGitBranch } from "@/shared/git/use-git-branch";
import { useTheme } from "@/shared/providers/theme/theme-provider";

/** Current workspace as `cwd:branch`, dropping the branch outside a git repo. */
export function WorkspacePath() {
	const { colors } = useTheme();
	const cwd = process.cwd();
	const branch = useGitBranch(cwd);
	const [repositoryUrl, setRepositoryUrl] = useState<string | null>(null);

	useEffect(() => {
		let ignore = false;
		void getGitRepositoryWebUrl(cwd).then((result) => {
			if (!ignore) {
				setRepositoryUrl(result);
			}
		});
		return () => {
			ignore = true;
		};
	}, [cwd]);

	const branchUrl =
		branch && repositoryUrl
			? `${repositoryUrl}/tree/${branch
					.split("/")
					.map(encodeURIComponent)
					.join("/")}`
			: null;

	return (
		<text fg={colors.filePath} flexShrink={1} wrapMode="none">
			<a href={url.pathToFileURL(cwd).href}>
				<u>
					<span fg={colors.filePath}>{path.basename(cwd) || path.sep}</span>
				</u>
			</a>
			{branch ? (
				<>
					<span>:</span>
					{branchUrl ? (
						<a href={branchUrl}>
							<u>
								<b fg={colors.success}>{branch}</b>
							</u>
						</a>
					) : (
						<b fg={colors.success}>{branch}</b>
					)}
				</>
			) : null}
		</text>
	);
}
