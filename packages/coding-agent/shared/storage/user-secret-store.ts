import * as fs from "node:fs/promises";
import { readSecureJsonFile, writeSecureJsonFile } from "./secure-json-file";

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

const readDocument = async (
	filePath: string,
	secretLabel: string
): Promise<Record<string, string>> => {
	const parsed = await readSecureJsonFile(filePath, secretLabel);
	if (parsed === undefined) {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid ${secretLabel} document: ${filePath}`);
	}
	return Object.fromEntries(
		Object.entries(parsed).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string"
		)
	);
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
					await writeSecureJsonFile(filePath, document, secretLabel);
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
					if (value !== null && value.length > 0) {
						return value;
					}
				} catch {
					platformStore = undefined;
				}
			}
			return readFileStore(key);
		},
		async set(key: string, value: string): Promise<void> {
			assertKey(key);
			const store = platformStore;
			let storedOnPlatform = false;
			if (store?.set !== undefined) {
				try {
					await store.set({
						name: accountFor(key),
						service: platformService,
						value,
					});
					storedOnPlatform = true;
				} catch {
					platformStore = undefined;
				}
			}
			await updateFileStore((document) => {
				if (storedOnPlatform) {
					delete document[key];
				} else {
					document[key] = value;
				}
			});
		},
		async delete(key: string): Promise<void> {
			assertKey(key);
			const store = platformStore;
			if (store !== undefined) {
				try {
					if (store.delete !== undefined) {
						await store.delete({
							name: accountFor(key),
							service: platformService,
						});
					} else if (store.set === undefined) {
						throw new Error(
							`The ${secretLabel} platform store does not support deletion.`
						);
					} else {
						await store.set({
							name: accountFor(key),
							service: platformService,
							value: "",
						});
					}
				} catch (error) {
					throw new Error(
						`Could not delete ${secretLabel} from the platform secret store.`,
						{ cause: error }
					);
				}
			}
			await updateFileStore((document) => {
				delete document[key];
			});
		},
	});
};
