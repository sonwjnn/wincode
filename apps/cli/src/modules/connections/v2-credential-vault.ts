import {
	chmod,
	lstat,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ConnectionProviderId } from "@wincode/ai";
import type { CredentialByProvider } from "./contract";
import { defaultProviderRegistry } from "./provider-registry";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SERVICE_NAME = "wincode";

type BunSecretStore = {
	get?: (input: { service: string; name: string }) => Promise<string | null>;
	set?: (input: {
		service: string;
		name: string;
		value: string;
	}) => Promise<void>;
};

export type SecretStore = {
	get(service: string, account: string): Promise<string | null>;
	set(service: string, account: string, secret: string): Promise<void>;
};

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
) => join(fileRoot, ".wincode", "connections-v2", `${providerId}.json`);

export class CredentialVaultV2 {
	private readonly secretStore: SecretStore | null;
	private readonly fileRoot: string;

	constructor(options: V2CredentialVaultOptions = {}) {
		this.secretStore =
			options.secretStore ?? getBunSecretStore(options.bunSecrets);
		this.fileRoot = options.fileRoot ?? homedir();
	}

	async load<P extends ConnectionProviderId>(
		providerId: P
	): Promise<CredentialByProvider[P] | null>;
	async load<P extends ConnectionProviderId>(
		providerId: P
	): Promise<CredentialByProvider[P] | null> {
		const raw =
			this.secretStore === null
				? await this.readFile(providerId)
				: await this.secretStore.get(
						SERVICE_NAME,
						`connections-v2:${providerId}`
					);
		return raw === null ? null : parseStoredCredential(providerId, raw);
	}

	async replaceValidated<P extends ConnectionProviderId>(
		providerId: P,
		credential: CredentialByProvider[P]
	): Promise<void> {
		const validated = parseCredential(providerId, credential);
		if (this.secretStore !== null) {
			await this.secretStore.set(
				SERVICE_NAME,
				`connections-v2:${providerId}`,
				JSON.stringify(validated)
			);
			return;
		}

		await this.writeFile(providerId, validated);
	}

	private async readFile(
		providerId: ConnectionProviderId
	): Promise<string | null> {
		const path = connectionFilePath(providerId, this.fileRoot);
		try {
			await assertSecureVaultDirectories(path);
			await assertSecurePath(path);
			return await readFile(path, "utf8");
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
		const path = connectionFilePath(providerId, this.fileRoot);
		const wincodeDirectory = dirname(dirname(path));
		const connectionsDirectory = dirname(path);

		await ensureSecureOwnedDirectory(wincodeDirectory);
		await ensureSecureOwnedDirectory(connectionsDirectory);
		await rejectNonRegularFile(path);
		const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
		try {
			await writeFile(temporaryPath, JSON.stringify(credential, null, 2), {
				encoding: "utf8",
				flag: "wx",
				mode: FILE_MODE,
			});
			await chmod(temporaryPath, FILE_MODE);
			await rename(temporaryPath, path);
		} catch (error) {
			await rm(temporaryPath, { force: true });
			throw error;
		}
	}
}

const getBunSecretStore = (
	injectedSecrets?: BunSecretStore | null
): SecretStore | null => {
	if (injectedSecrets === null) {
		return null;
	}
	const secrets =
		injectedSecrets ??
		(globalThis as typeof globalThis & { Bun?: { secrets?: BunSecretStore } })
			.Bun?.secrets;
	if (
		secrets === undefined ||
		secrets === null ||
		secrets.get === undefined ||
		secrets.set === undefined
	) {
		return null;
	}

	return {
		get(service: string, account: string): Promise<string | null> {
			return Promise.resolve(secrets.get?.({ service, name: account }) ?? null);
		},
		async set(service: string, account: string, secret: string): Promise<void> {
			await secrets.set?.({ service, name: account, value: secret });
		},
	};
};

const rejectNonRegularFile = async (path: string): Promise<void> => {
	try {
		const stats = await lstat(path);
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

const assertSecurePath = async (path: string): Promise<void> => {
	await assertSecureDirectoryChain(dirname(path));
	await rejectNonRegularFile(path);
};

const assertSecureVaultDirectories = async (path: string): Promise<void> => {
	const wincodeDirectory = dirname(dirname(path));
	const connectionsDirectory = dirname(path);
	await assertSecureDirectoryChain(wincodeDirectory);
	await assertSecureDirectoryChain(connectionsDirectory);
};

const ensureSecureOwnedDirectory = async (directory: string): Promise<void> => {
	await mkdir(directory, { mode: DIRECTORY_MODE, recursive: true });
	await assertSecureDirectoryChain(directory);
};

const assertSecureDirectoryChain = async (directory: string): Promise<void> => {
	try {
		const stats = await lstat(directory);
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
	error instanceof Error && "code" in error && error.code === "ENOENT";

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
