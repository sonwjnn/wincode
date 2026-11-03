import * as fs from "node:fs/promises";
import * as path from "node:path";

const listEntries = async (
	root: string,
	directory = root
): Promise<string[]> => {
	const entries = await fs.readdir(directory, { withFileTypes: true });
	const nestedEntries = await Promise.all(
		entries.map(async (entry) => {
			const entryPath = path.join(directory, entry.name);
			const relativePath = path.relative(root, entryPath);
			if (!entry.isDirectory()) {
				return [relativePath];
			}
			return [relativePath, ...(await listEntries(root, entryPath))];
		})
	);
	return nestedEntries.flat();
};

const describeError = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** Reports remaining paths when Windows cannot release a test root for cleanup. */
export const removeTemporaryDirectory = async (
	directory: string
): Promise<void> => {
	try {
		await fs.rm(directory, { force: true, recursive: true });
	} catch (error) {
		const remainingEntries = await listEntries(directory).catch(
			(listingError) => [`<listing failed: ${describeError(listingError)}>`]
		);
		throw new Error(
			`Failed to remove temporary test directory; remaining entries: ${remainingEntries.join(", ") || "<empty>"}.`,
			{ cause: error }
		);
	}
};
