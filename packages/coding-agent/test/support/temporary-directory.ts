import * as fs from "node:fs/promises";

/** Windows can transiently keep recursively removed test roots busy after handles close. */
export const removeTemporaryDirectory = async (
	directory: string
): Promise<void> => {
	await fs.rm(directory, {
		force: true,
		maxRetries: 5,
		recursive: true,
		retryDelay: 100,
	});
};
