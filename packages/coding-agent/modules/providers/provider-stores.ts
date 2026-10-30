import * as path from "node:path";
import type {
	CredentialMetadata,
	CredentialStore,
	ModelStore,
	ProviderModel,
} from "@wincode/ai";
import { resolveUserDataDir } from "@/shared/paths/user-data-dir";
import { withAuthFile } from "@/shared/storage/auth-file";
import {
	readSecureJsonFile,
	writeSecureJsonFile,
} from "@/shared/storage/secure-json-file";

const providerIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const fileWriteQueues = new Map<string, Promise<void>>();

export const isValidProviderId = (providerId: string): boolean =>
	providerIdPattern.test(providerId);

export type ProviderSdkStoreOptions = Readonly<{ userDataDir?: string }>;

const providerIdForStorage = (providerId: string): string => {
	if (!isValidProviderId(providerId)) {
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

const assertCredential = (credential: unknown): void => {
	if (JSON.stringify(credential) === undefined) {
		throw new Error("Provider SDK credential must be JSON serializable.");
	}
};

/** Creates the distinct application Provider SDK credential namespace. */
export const createProviderSdkCredentialStore = (
	options: ProviderSdkStoreOptions = {}
): CredentialStore => {
	const userDataDir = options.userDataDir ?? resolveUserDataDir();
	return Object.freeze({
		delete(providerId, { signal } = {}) {
			const storageId = providerIdForStorage(providerId);
			return withAuthFile(
				userDataDir,
				async (document, save) => {
					if (!Object.hasOwn(document.providers, storageId)) {
						return;
					}
					delete document.providers[storageId];
					await save();
				},
				signal
			);
		},
		list({ signal } = {}): Promise<readonly CredentialMetadata[]> {
			return withAuthFile(
				userDataDir,
				async (document) =>
					Object.entries(document.providers)
						.filter(([id]) => isValidProviderId(id))
						.map(([providerId, credential]) => ({
							providerId,
							type: credentialTypeFor(credential),
						}))
						.sort((left, right) =>
							left.providerId.localeCompare(right.providerId)
						),
				signal
			);
		},
		has(providerId, { signal } = {}) {
			const storageId = providerIdForStorage(providerId);
			return withAuthFile(
				userDataDir,
				async (document) => Object.hasOwn(document.providers, storageId),
				signal
			);
		},
		modify(providerId, update, { signal } = {}) {
			const storageId = providerIdForStorage(providerId);
			return withAuthFile(
				userDataDir,
				async (document, save) => {
					const previous = Object.hasOwn(document.providers, storageId)
						? document.providers[storageId]
						: undefined;
					const replacement = await update(previous);
					if (replacement === undefined) {
						return previous;
					}
					assertCredential(replacement);
					document.providers[storageId] = replacement;
					await save();
					return replacement;
				},
				signal
			);
		},
		read(providerId, { signal } = {}) {
			const storageId = providerIdForStorage(providerId);
			return withAuthFile(
				userDataDir,
				async (document) =>
					Object.hasOwn(document.providers, storageId)
						? document.providers[storageId]
						: undefined,
				signal
			);
		},
	});
};

/** Creates a user-scoped offline store for last-successful Provider Models. */
export const createProviderSdkModelStore = (
	options: ProviderSdkStoreOptions = {}
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
	options: ProviderSdkStoreOptions = {}
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
