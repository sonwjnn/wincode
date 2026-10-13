import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	CredentialStore,
	ModelStore,
	ProviderModel,
} from "@wincode/ai/sdk";
import { isObjectLike, readUtf8File } from "@wincode/utils";
import { resolveUserDataDir } from "@/shared/paths/user-data-dir";
import { createUserSecretStore } from "@/shared/storage/user-secret-store";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const providerIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const modelWriteQueues = new Map<string, Promise<void>>();

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

const isMissingFileError = (error: unknown): boolean =>
	isObjectLike(error) && "code" in error && error.code === "ENOENT";

const assertSecureMode = (mode: number, filePath: string): void => {
	if (mode % 0o100 !== 0) {
		throw new Error(
			`Refusing insecure Provider Model snapshot permissions: ${filePath}`
		);
	}
};

const throwIfAborted = (signal: AbortSignal | undefined): void => {
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException("Aborted", "AbortError");
	}
};

const queueModelWrite = async (
	filePath: string,
	write: () => Promise<void>
): Promise<void> => {
	const previous = modelWriteQueues.get(filePath) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(write);
	modelWriteQueues.set(filePath, current);
	try {
		await current;
	} finally {
		if (modelWriteQueues.get(filePath) === current) {
			modelWriteQueues.delete(filePath);
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
	return Object.freeze({
		delete: (providerId) => secrets.delete(providerIdForStorage(providerId)),
		get: async (providerId) => {
			const stored = await secrets.get(providerIdForStorage(providerId));
			if (stored === undefined) {
				return;
			}
			try {
				return JSON.parse(stored) as unknown;
			} catch {
				throw new Error("Stored Provider SDK credential is invalid.");
			}
		},
		set: (providerId, credential) =>
			secrets.set(providerIdForStorage(providerId), JSON.stringify(credential)),
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
			try {
				const stats = await fs.lstat(filePath);
				if (!stats.isFile()) {
					throw new Error(
						`Refusing non-regular Provider Model snapshot: ${filePath}`
					);
				}
				assertSecureMode(stats.mode, filePath);
				const snapshot: unknown = JSON.parse(await readUtf8File(filePath));
				if (!Array.isArray(snapshot)) {
					throw new Error(`Invalid Provider Model snapshot: ${filePath}`);
				}
				return snapshot as readonly ProviderModel[];
			} catch (error) {
				if (isMissingFileError(error)) {
					return;
				}
				throw error;
			}
		},
		set(providerId, models, { signal }): Promise<void> {
			const filePath = modelSnapshotPathFor(userDataDir, providerId);
			return queueModelWrite(filePath, async () => {
				throwIfAborted(signal);
				const directory = path.dirname(filePath);
				await fs.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
				const directoryStats = await fs.lstat(directory);
				if (!directoryStats.isDirectory()) {
					throw new Error(
						`Refusing insecure Provider Model snapshot directory: ${directory}`
					);
				}
				assertSecureMode(directoryStats.mode, directory);
				const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
				try {
					await fs.writeFile(temporaryPath, JSON.stringify(models, null, 2), {
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
			});
		},
	});
};
