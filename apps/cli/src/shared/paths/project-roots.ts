import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const getProjectRoots = (workspace: string): string[] => {
	const start = resolve(workspace);
	const ancestors: string[] = [];
	let current = start;
	while (true) {
		ancestors.push(current);
		if (existsSync(join(current, ".git"))) {
			return ancestors.reverse();
		}
		const parent = dirname(current);
		if (parent === current) {
			return [start];
		}
		current = parent;
	}
};
