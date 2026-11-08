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

const isBusyFileSystemError = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	Reflect.get(error, "code") === "EBUSY";

/** Collects deferred SQLite statement finalizers before Windows temp cleanup. */
export const removeTemporaryDirectory = async (
	directory: string
): Promise<void> => {
	for (let attempt = 0; ; attempt++) {
		if (process.platform === "win32") {
			Bun.gc(true);
		}
		try {
			await fs.rm(directory, { force: true, recursive: true });
			return;
		} catch (error) {
			if (
				process.platform !== "win32" ||
				attempt === 20 ||
				!isBusyFileSystemError(error)
			) {
				const remainingEntries = await listEntries(directory).catch(
					(listingError) => [`<listing failed: ${describeError(listingError)}>`]
				);
				throw new Error(
					`Failed to remove temporary test directory; remaining entries: ${remainingEntries.join(", ") || "<empty>"}.`,
					{ cause: error }
				);
			}
			await Bun.sleep(100);
		}
	}
};
