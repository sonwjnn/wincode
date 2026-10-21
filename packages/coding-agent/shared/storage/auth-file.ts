import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getErrorCode } from "@/shared/utils/error-log-fields";
import { withCrossProcessFileLock } from "./cross-process-file-lock";
import { readSecureJsonFile, writeSecureJsonFile } from "./secure-json-file";

export type AuthDocument = Readonly<{ providers: Record<string, unknown> }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const assertOwnedDirectory = async (directory: string): Promise<void> => {
	try {
		const stats = await fs.lstat(directory);
		if (
			!stats.isDirectory() ||
			(process.getuid?.() !== undefined && stats.uid !== process.getuid())
		) {
			throw new Error(`Refusing insecure auth directory: ${directory}`);
		}
	} catch (error) {
		if (getErrorCode(error) !== "ENOENT") {
			throw error;
		}
	}
};

/** One locked, owner-only JSON transaction; read-modify-write never spans files. */
const withPrivateJsonFile = async <Document, Result>(
	userDataDir: string,
	filePath: string,
	parse: (value: unknown | undefined) => Document,
	operation: (document: Document, save: () => Promise<void>) => Promise<Result>,
	signal?: AbortSignal
): Promise<Result> => {
	const directory = path.dirname(filePath);
	await assertOwnedDirectory(userDataDir);
	await assertOwnedDirectory(directory);
	return withCrossProcessFileLock(
		`${filePath}.lock`,
		async () => {
			await assertOwnedDirectory(userDataDir);
			await assertOwnedDirectory(directory);
			const document = parse(await readSecureJsonFile(filePath, "auth"));
			// A started refresh must persist even after its caller cancels.
			return operation(document, () =>
				writeSecureJsonFile(filePath, document, "auth")
			);
		},
		signal
	);
};

/** Provider credentials live in auth.json; old Plugin entries are never loaded. */
export const withAuthFile = <Result>(
	userDataDir: string,
	operation: (
		document: AuthDocument,
		save: () => Promise<void>
	) => Promise<Result>,
	signal?: AbortSignal
): Promise<Result> =>
	withPrivateJsonFile(
		userDataDir,
		path.join(userDataDir, "auth.json"),
		(value): AuthDocument => {
			if (value === undefined) {
				return { providers: Object.create(null) as Record<string, unknown> };
			}
			if (!(isRecord(value) && isRecord(value.providers))) {
				throw new Error("Invalid auth document.");
			}
			return { providers: value.providers };
		},
		operation,
		signal
	);

/** Plugin and MCP secrets use their own file locks, never Provider auth.json. */
export const withSecretFile = <Result>(
	userDataDir: string,
	filePath: string,
	operation: (
		secrets: Record<string, string>,
		save: () => Promise<void>
	) => Promise<Result>
): Promise<Result> =>
	withPrivateJsonFile(
		userDataDir,
		filePath,
		(value): Record<string, string> => {
			if (value === undefined) {
				return Object.create(null) as Record<string, string>;
			}
			if (
				!isRecord(value) ||
				Object.values(value).some((entry) => typeof entry !== "string")
			) {
				throw new Error("Invalid secret document.");
			}
			return value as Record<string, string>;
		},
		operation
	);
