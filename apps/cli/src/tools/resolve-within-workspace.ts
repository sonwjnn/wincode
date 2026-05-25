import { realpathSync } from "node:fs";
import path from "node:path";

export const WORKSPACE = realpathSync(process.cwd());

export function resolveWithinWorkspace(input: string) {
	const resolved = path.resolve(WORKSPACE, input);

	if (!(resolved.startsWith(WORKSPACE + path.sep) || resolved === WORKSPACE)) {
		throw new Error(`Path escapes workspace: ${input}`);
	}

	return resolved;
}
