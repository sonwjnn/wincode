import type { WorkspacePolicy } from "@wincode/ai/workspace";

/**
 * Canonicalizes a read resource to a workspace-relative POSIX path after
 * normal workspace sandbox resolution (realpath and inside-workspace
 * assertions). Missing paths use the sandbox's new-path resolution so parent
 * symlinks and workspace boundaries remain enforced before policy evaluation.
 */
export async function canonicalizeResource(
	input: string,
	sandbox: WorkspacePolicy
): Promise<string> {
	try {
		const absolutePath = await sandbox.resolveExistingPath(input);
		return sandbox.relativePath(absolutePath);
	} catch {
		const newPath = await sandbox.resolveNewPath(input);
		return sandbox.relativePath(newPath);
	}
}
