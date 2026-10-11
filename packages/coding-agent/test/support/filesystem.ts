import * as fs from "node:fs/promises";
import * as path from "node:path";

export const writeFixture = async (
	filePath: string,
	contents: string
): Promise<void> => {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, contents);
};
