import * as path from "node:path";
import type {
	CredentialMetadata,
	CredentialStore,
	ModelStore,
	ProviderModel,
} from "@wincode/ai";
import { resolveUserDataDir } from "@/shared/paths/user-data-dir";
import { withCrossProcessFileLock } from "@/shared/storage/cross-process-file-lock";
import {
	readSecureJsonFile,
	writeSecureJsonFile,
} from "@/shared/storage/secure-json-file";
import { createUserSecretStore } from "@/shared/storage/user-secret-store";

const providerIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const fileWriteQueues = new Map<string, Promise<void>>();

type BunSecretStore = Partial<typeof Bun.secrets>;

export type ProviderSdkStoreOptions = Readonly<{
	platformStore?: BunSecretStore | null;
	userDataDir?: string;
}>;

const providerIdForStorage = (providerId: string): string => {
	if (!providerIdPattern.test(providerId)) {
		throw new Error("Invalid Provider ID for user-scoped storage.");
	}
	return providerId;
};

/** Stable storage identity for one Plugin Provider registration owner. */
export const pluginProviderStorageId = (input: {
	pluginId: string;
	providerId: string;
	sourceIdentity: string;
}): string => {
	providerIdForStorage(input.providerId);
	if (input.pluginId.trim().length === 0 || input.sourceIdentity.length === 0) {
		throw new Error("Invalid Plugin Provider registration owner.");
	}
	const identity = JSON.stringify([
		input.pluginId,
		input.sourceIdentity,
		input.providerId,
	]);
	const digest = new Bun.CryptoHasher("sha256").update(identity).digest("hex");
	return `plugin-${digest}`;
};

const queueFileWrite = async (
	filePath: string,
	write: () => Promise<void>
): Promise<void> => {
	const previous = fileWriteQueues.get(filePath) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(write);
	fileWriteQueues.set(filePath, current);
	try {
		await current;
	} finally {
		if (fileWriteQueues.get(filePath) === current) {
			fileWriteQueues.delete(filePath);
		}
	}
};

const modelSnapshotPathFor = (
	userDataDir: string,
	providerId: string
): string =>
	path.join(
		userDataDir,
		"provider-sdk-models",
		`${providerIdForStorage(providerId)}.json`
	);

const credentialIndexPathFor = (userDataDir: string): string =>
	path.join(userDataDir, "provider-sdk-credential-index.json");

const credentialTypeFor = (credential: unknown): string => {
	if (typeof credential !== "object" || credential === null) {
		return "unknown";
	}
	if ("kind" in credential && typeof credential.kind === "string") {
		return credential.kind;
	}
	if ("type" in credential && typeof credential.type === "string") {
		return credential.type;
	}
	return "unknown";
};

const readLegacyCredentialMetadata = async (
	indexPath: string
): Promise<readonly CredentialMetadata[]> => {
	const credentialFilePath = path.join(
		path.dirname(indexPath),
		"provider-sdk-credentials.json"
	);
	const snapshot = await readSecureJsonFile(
		credentialFilePath,
		"Provider SDK credential"
	);
	if (snapshot === undefined) {
		return [];
	}
	if (
		typeof snapshot !== "object" ||
		snapshot === null ||
		Array.isArray(snapshot)
	) {
		throw new Error(
			`Invalid Provider SDK credential document: ${credentialFilePath}`
		);
	}
	return Object.entries(snapshot).flatMap(([providerId, serialized]) => {
		if (!providerIdPattern.test(providerId) || typeof serialized !== "string") {
			return [];
		}
		let credential: unknown;
		try {
			credential = JSON.parse(serialized) as unknown;
		} catch {
			return [{ providerId, type: "unknown" }];
		}
		return [{ providerId, type: credentialTypeFor(credential) }];
	});
};

const readCredentialIndex = async (
	filePath: string
): Promise<readonly CredentialMetadata[]> => {
	const snapshot = await readSecureJsonFile(
		filePath,
		"Provider SDK credential index"
	);
	if (snapshot === undefined) {
		return readLegacyCredentialMetadata(filePath);
	}
	if (!Array.isArray(snapshot)) {
		throw new Error(`Invalid Provider SDK credential index: ${filePath}`);
	}
	const entries: CredentialMetadata[] = [];
	for (const entry of snapshot as readonly unknown[]) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			!("providerId" in entry) ||
			typeof entry.providerId !== "string" ||
			!("type" in entry) ||
			typeof entry.type !== "string"
		) {
			throw new Error(`Invalid Provider SDK credential index: ${filePath}`);
		}
		entries.push({ providerId: entry.providerId, type: entry.type });
	}
	return entries;
};

const writeCredentialIndex = async (
	filePath: string,
	providerId: string,
	credential: unknown | undefined
): Promise<void> =>
	queueFileWrite(filePath, async () => {
		const indexExists = await Bun.file(filePath).exists();
		const entries = new Map(
			(await readCredentialIndex(filePath)).map((entry) => [
				entry.providerId,
				entry,
			])
		);
		const nextEntry =
			credential === undefined
				? undefined
				: { providerId, type: credentialTypeFor(credential) };
		const previousEntry = entries.get(providerId);
		if (
			indexExists &&
			((previousEntry === undefined && nextEntry === undefined) ||
				(previousEntry !== undefined &&
					nextEntry !== undefined &&
					previousEntry.type === nextEntry.type))
		) {
			return;
		}
		if (nextEntry === undefined) {
			entries.delete(providerId);
		} else {
			entries.set(providerId, nextEntry);
		}
		await writeSecureJsonFile(
			filePath,
			[...entries.values()].sort((left, right) =>
				left.providerId.localeCompare(right.providerId)
			),
			"Provider SDK credential index"
		);
	});

/** Creates the distinct application Provider SDK credential namespace. */
export const createProviderSdkCredentialStore = (
	options: ProviderSdkStoreOptions = {}
): CredentialStore => {
	const userDataDir = options.userDataDir ?? resolveUserDataDir();
	const secrets = createUserSecretStore({
		accountPrefix: "provider-sdk",
		filePath: path.join(userDataDir, "provider-sdk-credentials.json"),
		platformService: "wincode-provider-sdk",
		platformStore: options.platformStore,
		secretLabel: "Provider SDK credential",
		validateKey: providerIdForStorage,
	});
	const indexPath = credentialIndexPathFor(userDataDir);
	const parseCredential = (stored: string | undefined): unknown | undefined => {
		if (stored === undefined) {
			return;
		}
		try {
			return JSON.parse(stored) as unknown;
		} catch {
			throw new Error("Stored Provider SDK credential is invalid.");
		}
	};
	const serializeCredential = (credential: unknown): string => {
		const serialized = JSON.stringify(credential);
		if (serialized === undefined) {
			throw new Error("Provider SDK credential must be JSON serializable.");
		}
		return serialized;
	};
	const restoreCredential = async (
		providerId: string,
		credential: unknown | undefined
	): Promise<void> => {
		if (credential === undefined) {
			await secrets.delete(providerId);
		} else {
			await secrets.set(providerId, serializeCredential(credential));
		}
		await writeCredentialIndex(indexPath, providerId, credential);
	};
	return Object.freeze({
		async delete(providerId, { signal } = {}) {
			const storageId = providerIdForStorage(providerId);
			await withCrossProcessFileLock(
				`${indexPath}.index.lock`,
				async () => {
					const previous = parseCredential(
						await secrets.get(storageId, { signal })
					);
					try {
						await secrets.delete(storageId, { signal });
						await writeCredentialIndex(indexPath, storageId, undefined);
					} catch (error) {
						try {
							await restoreCredential(storageId, previous);
						} catch (recoveryError) {
							throw new Error(
								"Provider credential removal failed and could not be recovered.",
								{
									cause: new AggregateError(
										[error, recoveryError],
										"Provider credential removal rollback failed."
									),
								}
							);
						}
						throw error;
					}
				},
				signal
			);
		},
		async list({ signal } = {}) {
			return withCrossProcessFileLock(
				`${indexPath}.index.lock`,
				async () => {
					const entries = await readCredentialIndex(indexPath);
					if (entries.length > 0 && !(await Bun.file(indexPath).exists())) {
						await writeSecureJsonFile(
							indexPath,
							entries,
							"Provider SDK credential index"
						);
					}
					return entries;
				},
				signal
			);
		},
		async modify(providerId, update, { signal } = {}) {
			const storageId = providerIdForStorage(providerId);
			return withCrossProcessFileLock(
				`${indexPath}.index.lock`,
				async () => {
					const previous = parseCredential(
						await secrets.get(storageId, { signal })
					);
					let replacementRequested = false;
					try {
						const stored = await secrets.modify(
							storageId,
							async (current) => {
								if (signal?.aborted) {
									throw (
										signal.reason ?? new DOMException("Aborted", "AbortError")
									);
								}
								const replacement = await update(parseCredential(current));
								replacementRequested = replacement !== undefined;
								return replacement === undefined
									? undefined
									: serializeCredential(replacement);
							},
							{ signal }
						);
						const credential = parseCredential(stored);
						await writeCredentialIndex(indexPath, storageId, credential);
						return credential;
					} catch (error) {
						if (replacementRequested) {
							try {
								await restoreCredential(storageId, previous);
							} catch (recoveryError) {
								throw new Error(
									"Provider credential update failed and could not be recovered.",
									{
										cause: new AggregateError(
											[error, recoveryError],
											"Provider credential update rollback failed."
										),
									}
								);
							}
						}
						throw error;
					}
				},
				signal
			);
		},
		async read(providerId, { signal } = {}) {
			const storageId = providerIdForStorage(providerId);
			return withCrossProcessFileLock(
				`${indexPath}.index.lock`,
				async () => {
					const stored = await secrets.get(storageId, { signal });
					return parseCredential(stored);
				},
				signal
			);
		},
	});
};

/** Creates a user-scoped offline store for last-successful Provider Models. */
export const createProviderSdkModelStore = (
	options: Pick<ProviderSdkStoreOptions, "userDataDir"> = {}
): ModelStore => {
	const userDataDir = options.userDataDir ?? resolveUserDataDir();
	return Object.freeze({
		async get(providerId): Promise<readonly ProviderModel[] | undefined> {
			const filePath = modelSnapshotPathFor(userDataDir, providerId);
			const snapshot = await readSecureJsonFile(
				filePath,
				"Provider Model snapshot"
			);
			if (snapshot === undefined) {
				return;
			}
			if (!Array.isArray(snapshot)) {
				throw new Error(`Invalid Provider Model snapshot: ${filePath}`);
			}
			return snapshot as readonly ProviderModel[];
		},
		set(providerId, models, { signal }): Promise<void> {
			const filePath = modelSnapshotPathFor(userDataDir, providerId);
			return queueFileWrite(filePath, () =>
				writeSecureJsonFile(filePath, models, "Provider Model snapshot", {
					signal,
				})
			);
		},
	});
};

export type ProviderSdkStores = Readonly<{
	credentialStore: CredentialStore;
	modelStore: ModelStore;
}>;

const providerSdkStoresByUserDataDir = new Map<string, ProviderSdkStores>();

/** Shares the app-owned Provider SDK stores across separate Host compositions. */
export const getProviderSdkStores = (
	options: Pick<ProviderSdkStoreOptions, "userDataDir"> = {}
): ProviderSdkStores => {
	const userDataDir = options.userDataDir ?? resolveUserDataDir();
	let stores = providerSdkStoresByUserDataDir.get(userDataDir);
	if (stores === undefined) {
		stores = Object.freeze({
			credentialStore: createProviderSdkCredentialStore({ userDataDir }),
			modelStore: createProviderSdkModelStore({ userDataDir }),
		});
		providerSdkStoresByUserDataDir.set(userDataDir, stores);
	}
	return stores;
};
