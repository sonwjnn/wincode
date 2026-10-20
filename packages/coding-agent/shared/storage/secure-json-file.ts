import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isObjectLike, readUtf8File } from "@wincode/utils";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

type SecureJsonWriteOptions = Readonly<{
	signal?: AbortSignal;
}>;

const isMissingFileError = (error: unknown): boolean =>
	isObjectLike(error) && "code" in error && error.code === "ENOENT";

const assertSecureMode = (
	mode: number,
	filePath: string,
	label: string
): void => {
	if (mode % 0o100 !== 0) {
		throw new Error(`Refusing insecure ${label} permissions: ${filePath}`);
	}
};

const throwIfAborted = (signal: AbortSignal | undefined): void => {
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException("Aborted", "AbortError");
	}
};

/** Reads one regular, owner-only JSON file; a missing file has no value. */
export const readSecureJsonFile = async (
	filePath: string,
	label: string
): Promise<unknown | undefined> => {
	try {
		const stats = await fs.lstat(filePath);
		if (!stats.isFile()) {
			throw new Error(`Refusing non-regular ${label} file: ${filePath}`);
		}
		assertSecureMode(stats.mode, filePath, label);
		return JSON.parse(await readUtf8File(filePath)) as unknown;
	} catch (error) {
		if (isMissingFileError(error)) {
			return;
		}
		throw error;
	}
};

/** Atomically writes JSON with owner-only file and directory permissions. */
export const writeSecureJsonFile = async (
	filePath: string,
	value: unknown,
	label: string,
	{ signal }: SecureJsonWriteOptions = {}
): Promise<void> => {
	throwIfAborted(signal);
	const serialized = JSON.stringify(value, null, 2);
	if (serialized === undefined) {
		throw new Error(`Could not serialize ${label} as JSON.`);
	}
	const directory = path.dirname(filePath);
	await fs.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
	const directoryStats = await fs.lstat(directory);
	if (!directoryStats.isDirectory()) {
		throw new Error(`Refusing insecure ${label} directory: ${directory}`);
	}
	assertSecureMode(directoryStats.mode, directory, label);
	const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporaryPath, serialized, {
			encoding: "utf8",
			flag: "wx",
			mode: FILE_MODE,
		});
		await fs.chmod(temporaryPath, FILE_MODE);
		throwIfAborted(signal);
		await fs.rename(temporaryPath, filePath);
	} finally {
		await fs.rm(temporaryPath, { force: true });
	}
};
