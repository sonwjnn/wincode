import { useEffect, useState } from "react";
import { getGitBranch } from "./get-git-branch";

export function useGitBranch(cwd: string): string | null {
	const [branch, setBranch] = useState<string | null>(null);

	useEffect(() => {
		let ignore = false;

		getGitBranch(cwd).then((result) => {
			if (!ignore) {
				setBranch(result);
			}
		});

		return () => {
			ignore = true;
		};
	}, [cwd]);

	return branch;
}
