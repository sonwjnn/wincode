import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isObjectLike, readUtf8File } from "@wincode/utils";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const defaultKeyPattern = /^[a-zA-Z0-9_.:-]{1,128}$/u;

type BunSecretStore = Partial<typeof Bun.secrets>;

export type UserSecretStore = Readonly<{
	delete: (key: string) => Promise<void>;
	get: (key: string) => Promise<string | undefined>;
	set: (key: string, value: string) => Promise<void>;
}>;

export type UserSecretStoreOptions = Readonly<{
	accountPrefix: string;
	filePath: string;
	platformService: string;
	platformStore?: BunSecretStore | null;
	secretLabel: string;
	validateKey?: (key: string) => void;
}>;

const getBunSecretStore = (): BunSecretStore | undefined => {
	const bun = (
		globalThis as typeof globalThis & {
			Bun?: { secrets?: BunSecretStore };
		}
	).Bun;
	const store = bun?.secrets;
	return store?.get !== undefined && store.set !== undefined
		? store
		: undefined;
};

const isMissingFileError = (error: unknown): boolean =>
	isObjectLike(error) && "code" in error && error.code === "ENOENT";

const assertSecureMode = (
	mode: number,
	filePath: string,
	secretLabel: string
): void => {
	if (mode % 0o100 !== 0) {
		throw new Error(
			`Refusing insecure ${secretLabel} permissions: ${filePath}`
		);
	}
};

const readDocument = async (
	filePath: string,
	secretLabel: string
): Promise<Record<string, string>> => {
	try {
		const stats = await fs.lstat(filePath);
		if (!stats.isFile()) {
			throw new Error(`Refusing non-regular ${secretLabel} file: ${filePath}`);
		}
		assertSecureMode(stats.mode, filePath, secretLabel);
		const parsed: unknown = JSON.parse(await readUtf8File(filePath));
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			throw new Error(`Invalid ${secretLabel} document: ${filePath}`);
		}
		return Object.fromEntries(
			Object.entries(parsed).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string"
			)
		);
	} catch (error) {
		if (isMissingFileError(error)) {
			return {};
		}
		throw error;
	}
};

const writeDocument = async (
	filePath: string,
	document: Readonly<Record<string, string>>,
	secretLabel: string
): Promise<void> => {
	const directory = path.dirname(filePath);
	await fs.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
	const directoryStats = await fs.lstat(directory);
	if (!directoryStats.isDirectory()) {
		throw new Error(`Refusing insecure ${secretLabel} directory: ${directory}`);
	}
	assertSecureMode(directoryStats.mode, directory, secretLabel);
	const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporaryPath, JSON.stringify(document, null, 2), {
			encoding: "utf8",
			flag: "wx",
			mode: FILE_MODE,
		});
		await fs.chmod(temporaryPath, FILE_MODE);
		await fs.rename(temporaryPath, filePath);
	} finally {
		await fs.rm(temporaryPath, { force: true });
	}
};

/** Creates one user-scoped, namespaced secret store with a secure file fallback. */
export const createUserSecretStore = ({
	accountPrefix,
	filePath,
	platformService,
	platformStore: providedPlatformStore,
	secretLabel,
	validateKey,
}: UserSecretStoreOptions): UserSecretStore => {
	let platformStore =
		providedPlatformStore === undefined
			? getBunSecretStore()
			: (providedPlatformStore ?? undefined);
	let writeQueue: Promise<void> = Promise.resolve();
	const accountFor = (key: string): string => `${accountPrefix}:${key}`;
	const assertKey = (key: string): void => {
		if (validateKey !== undefined) {
			validateKey(key);
			return;
		}
		if (!defaultKeyPattern.test(key)) {
			throw new Error(`${secretLabel} keys must be short identifiers.`);
		}
	};
	const updateFileStore = async (
		update: (document: Record<string, string>) => void
	): Promise<void> => {
		const previous = writeQueue;
		const current = previous
			.catch(() => undefined)
			.then(async () => {
				const document = await readDocument(filePath, secretLabel);
				update(document);
				if (Object.keys(document).length === 0) {
					await fs.rm(filePath, { force: true });
				} else {
					await writeDocument(filePath, document, secretLabel);
				}
			});
		writeQueue = current;
		try {
			await current;
		} finally {
			if (writeQueue === current) {
				writeQueue = Promise.resolve();
			}
		}
	};
	const readFileStore = async (key: string): Promise<string | undefined> =>
		(await readDocument(filePath, secretLabel))[key];

	return Object.freeze({
		async get(key: string): Promise<string | undefined> {
			assertKey(key);
			const store = platformStore;
			if (store?.get !== undefined) {
				try {
					const value = await store.get({
						name: accountFor(key),
						service: platformService,
					});
					return value === null || value.length === 0 ? undefined : value;
				} catch {
					platformStore = undefined;
				}
			}
			return readFileStore(key);
		},
		async set(key: string, value: string): Promise<void> {
			assertKey(key);
			const store = platformStore;
			if (store?.set !== undefined) {
				try {
					await store.set({
						name: accountFor(key),
						service: platformService,
						value,
					});
					return;
				} catch {
					platformStore = undefined;
				}
			}
			await updateFileStore((document) => {
				document[key] = value;
			});
		},
		async delete(key: string): Promise<void> {
			assertKey(key);
			const store = platformStore;
			if (store?.delete !== undefined) {
				try {
					await store.delete({
						name: accountFor(key),
						service: platformService,
					});
					return;
				} catch {
					platformStore = undefined;
				}
			} else if (store?.set !== undefined) {
				try {
					await store.set({
						name: accountFor(key),
						service: platformService,
						value: "",
					});
					return;
				} catch {
					platformStore = undefined;
				}
			}
			await updateFileStore((document) => {
				delete document[key];
			});
		},
	});
};
