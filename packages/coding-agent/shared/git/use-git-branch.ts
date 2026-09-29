import * as fs from "node:fs";
import * as path from "node:path";
import { useEffect, useState } from "react";
import { getGitBranch, getGitHeadPath } from "./get-git-branch";

const GIT_EVENT_SETTLE_MS = 50;

export function useGitBranch(cwd: string): string | null {
	const [branch, setBranch] = useState<string | null>(null);

	useEffect(() => {
		let ignore = false;
		let watcher: fs.FSWatcher | undefined;
		let refreshTimeout: NodeJS.Timeout | undefined;
		let reading = false;
		let changedDuringRead = false;

		const refreshBranch = async () => {
			if (ignore) {
				return;
			}
			if (reading) {
				changedDuringRead = true;
				return;
			}

			reading = true;
			do {
				changedDuringRead = false;
				const result = await getGitBranch(cwd);
				if (ignore) {
					return;
				}
				setBranch(result);
			} while (changedDuringRead);
			reading = false;
		};

		const start = async () => {
			const headPath = await getGitHeadPath(cwd);
			if (ignore) {
				return;
			}
			if (headPath) {
				try {
					// Git atomically replaces HEAD; Bun may report only the lockfile.
					watcher = fs.watch(path.dirname(headPath), (_event, filename) => {
						const name = filename?.toString();
						if (name !== undefined && name !== "HEAD" && name !== "HEAD.lock") {
							return;
						}
						clearTimeout(refreshTimeout);
						refreshTimeout = setTimeout(() => {
							void refreshBranch();
						}, GIT_EVENT_SETTLE_MS);
					});
					watcher.on("error", () => watcher?.close());
				} catch {
					// Git metadata can disappear while the workspace is open.
				}
			}
			void refreshBranch();
		};

		void start();
		return () => {
			ignore = true;
			clearTimeout(refreshTimeout);
			watcher?.close();
		};
	}, [cwd]);

	return branch;
}
