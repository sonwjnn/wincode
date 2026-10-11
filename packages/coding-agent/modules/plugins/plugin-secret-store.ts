import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { isObjectLike, readUtf8File } from "@wincode/utils";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SERVICE_NAME = "wincode-plugin";
const pluginIdPattern = /^[a-z0-9_]+$/u;
const secretKeyPattern = /^[a-zA-Z0-9_.:-]{1,128}$/u;

type BunSecretStore = Partial<typeof Bun.secrets>;

export type PluginSecretStore = Readonly<{
	delete: (key: string) => Promise<void>;
	get: (key: string) => Promise<string | undefined>;
	set: (key: string, value: string) => Promise<void>;
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

const assertSecureMode = (mode: number, filePath: string): void => {
	if (mode % 0o100 !== 0) {
		throw new Error(`Refusing insecure Plugin secret permissions: ${filePath}`);
	}
};

const readDocument = async (
	filePath: string
): Promise<Record<string, string>> => {
	try {
		const stats = await lstat(filePath);
		if (!stats.isFile()) {
			throw new Error(`Refusing non-regular Plugin secrets file: ${filePath}`);
		}
		assertSecureMode(stats.mode, filePath);
		const parsed: unknown = JSON.parse(await readUtf8File(filePath));
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			throw new Error(`Invalid Plugin secrets document: ${filePath}`);
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
	document: Readonly<Record<string, string>>
): Promise<void> => {
	const directory = path.dirname(filePath);
	await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
	const directoryStats = await lstat(directory);
	if (!directoryStats.isDirectory()) {
		throw new Error(`Refusing insecure Plugin secrets directory: ${directory}`);
	}
	assertSecureMode(directoryStats.mode, directory);
	const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, JSON.stringify(document, null, 2), {
			encoding: "utf8",
			flag: "wx",
			mode: FILE_MODE,
		});
		await chmod(temporaryPath, FILE_MODE);
		await rename(temporaryPath, filePath);
	} finally {
		await rm(temporaryPath, { force: true });
	}
};

/** Creates a user-scoped secret store owned by one Plugin identity. */
export const createPluginSecretStore = (
	pluginId: string,
	userDataDir: string,
	providedPlatformStore: BunSecretStore | null | undefined = getBunSecretStore()
): PluginSecretStore => {
	if (!pluginIdPattern.test(pluginId)) {
		throw new Error("Invalid Plugin Identifier for secret storage.");
	}
	const filePath = path.join(userDataDir, "plugin-secrets", `${pluginId}.json`);
	let platformStore = providedPlatformStore ?? undefined;
	let writeQueue: Promise<void> = Promise.resolve();
	const accountFor = (key: string): string => `${pluginId}:${key}`;
	const validateKey = (key: string): void => {
		if (!secretKeyPattern.test(key)) {
			throw new Error("Plugin secret keys must be short identifiers.");
		}
	};
	const withWriteLock = async (
		update: (document: Record<string, string>) => void
	): Promise<void> => {
		const previous = writeQueue;
		const current = previous
			.catch(() => undefined)
			.then(async () => {
				const document = await readDocument(filePath);
				update(document);
				if (Object.keys(document).length === 0) {
					await rm(filePath, { force: true });
				} else {
					await writeDocument(filePath, document);
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
		(await readDocument(filePath))[key];

	return Object.freeze({
		async get(key: string): Promise<string | undefined> {
			validateKey(key);
			const store = platformStore;
			if (store !== undefined && store.get !== undefined) {
				try {
					const value = await store.get({
						name: accountFor(key),
						service: SERVICE_NAME,
					});
					return value === null || value.length === 0 ? undefined : value;
				} catch {
					platformStore = undefined;
				}
			}
			return readFileStore(key);
		},
		async set(key: string, value: string): Promise<void> {
			validateKey(key);
			const store = platformStore;
			if (store !== undefined && store.set !== undefined) {
				try {
					await store.set({
						name: accountFor(key),
						service: SERVICE_NAME,
						value,
					});
					return;
				} catch {
					platformStore = undefined;
				}
			}
			await withWriteLock((document) => {
				document[key] = value;
			});
		},
		async delete(key: string): Promise<void> {
			validateKey(key);
			const store = platformStore;
			if (store !== undefined && store.delete !== undefined) {
				try {
					await store.delete({ name: accountFor(key), service: SERVICE_NAME });
					return;
				} catch {
					platformStore = undefined;
				}
			} else if (store !== undefined && store.set !== undefined) {
				try {
					await store.set({
						name: accountFor(key),
						service: SERVICE_NAME,
						value: "",
					});
					return;
				} catch {
					platformStore = undefined;
				}
			}
			await withWriteLock((document) => {
				delete document[key];
			});
		},
	});
};
