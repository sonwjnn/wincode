import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";

/**
 * Expands a leading `~` or `$HOME` in a configured path or rule pattern. Used
 * while compiling Permission rules so external-directory policies are portable
 * across user environments; canonical path evaluation happens at gate time.
 */
export const expandHomeInPath = (
	input: string,
	home: string = homedir()
): string => {
	if (input === "~") {
		return home;
	}
	if (input.startsWith("~/")) {
		return `${home}${input.slice(1)}`;
	}
	if (input.startsWith("$HOME")) {
		return `${home}${input.slice("$HOME".length)}`;
	}
	return input;
};

const findExistingParent = (targetPath: string): string => {
	let parentPath = targetPath;
	while (!existsSync(parentPath)) {
		const nextParentPath = dirname(parentPath);
		if (nextParentPath === parentPath) {
			return parentPath;
		}
		parentPath = nextParentPath;
	}
	return parentPath;
};

/**
 * Canonicalizes a filesystem path that lives outside the workspace: `~` and
 * `$HOME` are expanded, the nearest existing ancestor is realpath-resolved so
 * symlinks cannot alias a target, and the not-yet-existing suffix is appended
 * verbatim. The result is the canonical absolute path Permission evaluates.
 */
export async function canonicalizeExternalPath(
	input: string,
	baseRoot: string
): Promise<string> {
	const expanded = expandHomeInPath(input);
	const resolvedPath = resolve(baseRoot, expanded);
	const existingParent = findExistingParent(resolvedPath);
	const realParent = await realpath(existingParent);
	const suffix = resolvedPath.slice(existingParent.length);
	return `${realParent}${suffix}`;
}

/**
 * The canonical parent-directory glob a process-scoped `always` grant is keyed
 * by: approving one external path allows every canonical path below its real
 * parent directory, so approval scope is a bounded, predictable subtree.
 */
export const externalParentDirectoryGlob = (canonicalPath: string): string =>
	`${dirname(canonicalPath)}${sep}**`;
