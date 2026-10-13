import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ConnectionProviderId } from "@wincode/ai/models";
import { isError, isNull, isUndefined, readUtf8File } from "@wincode/utils";
import type { CredentialByProvider } from "./contract";
import { defaultProviderRegistry } from "./provider-registry";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SERVICE_NAME = "wincode";

type BunSecretStore = {
	delete?: (input: { service: string; name: string }) => Promise<boolean>;
	get?: (input: { service: string; name: string }) => Promise<string | null>;
	set?: (input: {
		service: string;
		name: string;
		value: string;
	}) => Promise<void>;
};

export type SecretStore = {
	delete?: (service: string, account: string) => Promise<boolean>;
	get(service: string, account: string): Promise<string | null>;
	set(service: string, account: string, secret: string): Promise<void>;
};

export type LegacyCredentialBackendStatus =
	| "not-configured"
	| "absent"
	| "deleted"
	| "unverified";

export type LegacyCredentialCleanupEntry = Readonly<{
	providerId: ConnectionProviderId;
	platform: LegacyCredentialBackendStatus;
	file: LegacyCredentialBackendStatus;
}>;

export type V2CredentialVaultOptions = {
	bunSecrets?: BunSecretStore | null;
	fileRoot?: string;
	secretStore?: SecretStore;
};

export class InvalidStoredConnectionError extends Error {
	constructor(providerId: ConnectionProviderId) {
		super(getInvalidStoredConnectionMessage(providerId));
		this.name = "InvalidStoredConnectionError";
	}
}

const connectionFilePath = (
	providerId: ConnectionProviderId,
	fileRoot: string
) => path.join(fileRoot, ".wincode", "connections-v2", `${providerId}.json`);

export class CredentialVaultV2 {
	private secretStore: SecretStore | null;
	private readonly fileRoot: string;

	constructor(options: V2CredentialVaultOptions = {}) {
		this.secretStore =
			options.secretStore ??
			(isUndefined(options.fileRoot)
				? getBunSecretStore(options.bunSecrets)
				: null);
		this.fileRoot = options.fileRoot ?? os.homedir();
	}

	async load<P extends ConnectionProviderId>(
		providerId: P
	): Promise<CredentialByProvider[P] | null>;
	async load<P extends ConnectionProviderId>(
		providerId: P
	): Promise<CredentialByProvider[P] | null> {
		const raw = await this.readRaw(providerId);
		return isNull(raw) ? null : parseStoredCredential(providerId, raw);
	}

	async replaceValidated<P extends ConnectionProviderId>(
		providerId: P,
		credential: CredentialByProvider[P]
	): Promise<void> {
		const validated = parseCredential(providerId, credential);
		if (!isNull(this.secretStore)) {
			await this.secretStore.set(
				SERVICE_NAME,
				`connections-v2:${providerId}`,
				JSON.stringify(validated)
			);
			return;
		}

		await this.writeFile(providerId, validated);
	}

	/** Removes and verifies both legacy backends without returning secret data. */
	async removeAndVerify(
		providerId: ConnectionProviderId
	): Promise<LegacyCredentialCleanupEntry> {
		const platform = await removeLegacyPlatformCredential(
			this.secretStore,
			providerId
		);
		const file = await removeLegacyFileCredential(providerId, this.fileRoot);
		return Object.freeze({ providerId, platform, file });
	}

	/**
	 * Reads the raw stored credential. An OS secret backend that is present but
	 * unusable — a headless Linux host without libsecret, for instance — is
	 * disabled for the vault's lifetime and its file store takes over, so
	 * listing and connecting providers still work where no keyring exists.
	 */
	private async readRaw(
		providerId: ConnectionProviderId
	): Promise<string | null> {
		const secretStore = this.secretStore;
		if (isNull(secretStore)) {
			return await this.readFile(providerId);
		}
		try {
			return await secretStore.get(
				SERVICE_NAME,
				`connections-v2:${providerId}`
			);
		} catch {
			this.secretStore = null;
			return await this.readFile(providerId);
		}
	}

	private async readFile(
		providerId: ConnectionProviderId
	): Promise<string | null> {
		const credentialPath = connectionFilePath(providerId, this.fileRoot);
		try {
			await assertSecurePath(credentialPath);
			return await readUtf8File(credentialPath);
		} catch (error) {
			if (isMissingFileError(error)) {
				return null;
			}

			throw error;
		}
	}

	private async writeFile<P extends ConnectionProviderId>(
		providerId: P,
		credential: CredentialByProvider[P]
	): Promise<void> {
		const credentialPath = connectionFilePath(providerId, this.fileRoot);
		const wincodeDirectory = path.dirname(path.dirname(credentialPath));
		const connectionsDirectory = path.dirname(credentialPath);

		await ensureSecureOwnedDirectory(wincodeDirectory);
		await ensureSecureOwnedDirectory(connectionsDirectory);
		await rejectNonRegularFile(credentialPath);
		const temporaryPath = `${credentialPath}.${crypto.randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporaryPath, JSON.stringify(credential, null, 2), {
				encoding: "utf8",
				flag: "wx",
				mode: FILE_MODE,
			});
			await fs.chmod(temporaryPath, FILE_MODE);
			await fs.rename(temporaryPath, credentialPath);
		} catch (error) {
			await fs.rm(temporaryPath, { force: true });
			throw error;
		}
	}
}

const getBunSecretStore = (
	injectedSecrets?: BunSecretStore | null
): SecretStore | null => {
	if (isNull(injectedSecrets)) {
		return null;
	}
	const secrets =
		injectedSecrets ??
		(globalThis as typeof globalThis & { Bun?: { secrets?: BunSecretStore } })
			.Bun?.secrets;
	if (
		isUndefined(secrets) ||
		isNull(secrets) ||
		isUndefined(secrets.get) ||
		isUndefined(secrets.set)
	) {
		return null;
	}

	const deleteSecret = secrets.delete;
	return {
		get(service: string, account: string): Promise<string | null> {
			return Promise.resolve(secrets.get?.({ service, name: account }) ?? null);
		},
		async set(service: string, account: string, secret: string): Promise<void> {
			await secrets.set?.({ service, name: account, value: secret });
		},
		...(deleteSecret === undefined
			? {}
			: {
					delete: (service: string, account: string): Promise<boolean> =>
						deleteSecret({ service, name: account }),
				}),
	};
};

const removeLegacyPlatformCredential = async (
	secretStore: SecretStore | null,
	providerId: ConnectionProviderId
): Promise<LegacyCredentialBackendStatus> => {
	if (isNull(secretStore)) {
		return "not-configured";
	}
	const account = `connections-v2:${providerId}`;
	try {
		if (isNull(await secretStore.get(SERVICE_NAME, account))) {
			return "absent";
		}
		if (isUndefined(secretStore.delete)) {
			return "unverified";
		}
		const deleted = await secretStore.delete(SERVICE_NAME, account);
		if (isNull(await secretStore.get(SERVICE_NAME, account))) {
			return deleted ? "deleted" : "absent";
		}
	} catch {
		return "unverified";
	}
	return "unverified";
};

const removeLegacyFileCredential = async (
	providerId: ConnectionProviderId,
	fileRoot: string
): Promise<LegacyCredentialBackendStatus> => {
	const filePath = connectionFilePath(providerId, fileRoot);
	try {
		await assertSecurePath(filePath);
		const existed = !(await isMissingPath(filePath));
		if (existed) {
			await fs.rm(filePath);
		}
		if (!(await isMissingPath(filePath))) {
			return "unverified";
		}
		return existed ? "deleted" : "absent";
	} catch {
		return "unverified";
	}
};

const isMissingPath = async (filePath: string): Promise<boolean> => {
	try {
		await fs.lstat(filePath);
		return false;
	} catch (error) {
		if (isMissingFileError(error)) {
			return true;
		}
		throw error;
	}
};

const rejectNonRegularFile = async (path: string): Promise<void> => {
	try {
		const stats = await fs.lstat(path);
		if (!stats.isFile()) {
			throw new Error(
				`Refusing to replace non-regular connections file: ${path}`
			);
		}
		assertSecureMode(
			stats.mode,
			`Refusing insecure connections file permissions: ${path}`
		);
	} catch (error) {
		if (isMissingFileError(error)) {
			return;
		}
		throw error;
	}
};

const assertSecurePath = async (targetPath: string): Promise<void> => {
	await assertSecureVaultDirectories(targetPath);
	await rejectNonRegularFile(targetPath);
};

const assertSecureVaultDirectories = async (
	targetPath: string
): Promise<void> => {
	const wincodeDirectory = path.dirname(path.dirname(targetPath));
	const connectionsDirectory = path.dirname(targetPath);
	await assertSecureDirectoryChain(wincodeDirectory);
	await assertSecureDirectoryChain(connectionsDirectory);
};

const ensureSecureOwnedDirectory = async (directory: string): Promise<void> => {
	await fs.mkdir(directory, { mode: DIRECTORY_MODE, recursive: true });
	await assertSecureDirectoryChain(directory);
};

const assertSecureDirectoryChain = async (directory: string): Promise<void> => {
	try {
		const stats = await fs.lstat(directory);
		if (!stats.isDirectory()) {
			throw new Error(`Refusing insecure connections directory: ${directory}`);
		}
		assertSecureMode(
			stats.mode,
			`Refusing insecure connections directory permissions: ${directory}`
		);
	} catch (error) {
		if (isMissingFileError(error)) {
			return;
		}
		throw error;
	}
};

const assertSecureMode = (mode: number, message: string): void => {
	if (process.platform === "win32") {
		return;
	}
	const permissions = mode.toString(8).slice(-3).padStart(3, "0");
	if (permissions[1] !== "0" || permissions[2] !== "0") {
		throw new Error(message);
	}
};

const isMissingFileError = (error: unknown): boolean =>
	isError(error) && "code" in error && error.code === "ENOENT";

const parseCredential = <P extends ConnectionProviderId>(
	providerId: P,
	input: unknown
): CredentialByProvider[P] => {
	// Indexed schemas are heterogeneous; this is the single localized Zod boundary.
	const schema = defaultProviderRegistry[providerId].credentialSchema as {
		parse(value: unknown): CredentialByProvider[P];
	};
	return schema.parse(input);
};

const parseStoredCredential = <P extends ConnectionProviderId>(
	providerId: P,
	raw: string
): CredentialByProvider[P] => {
	try {
		return parseCredential(providerId, JSON.parse(raw));
	} catch {
		throw new InvalidStoredConnectionError(providerId);
	}
};

const getInvalidStoredConnectionMessage = (
	providerId: ConnectionProviderId
): string =>
	`Stored ${defaultProviderRegistry[providerId].displayName} connection is invalid. Reconnect with /connect.`;
