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
import { z } from "zod";
import {
	type ConnectionStatus,
	type Credential,
	type CredentialByProvider,
	credentialSchemas,
	type LegacyWincodeSession,
	type ProviderId,
	type WincodeCredential,
} from "./types";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SERVICE_NAME = "wincode";
const ACCOUNT_NAME = "connections";

const recordSchema = z.object({
	anthropic: credentialSchemas.anthropic.optional(),
	openai: credentialSchemas.openai.optional(),
	wincode: credentialSchemas.wincode.optional(),
});

type ConnectionRecord = {
	anthropic?: CredentialByProvider["anthropic"];
	openai?: CredentialByProvider["openai"];
	wincode?: CredentialByProvider["wincode"];
};

type BunSecretStore = {
	get?: (input: { service: string; name: string }) => Promise<string | null>;
	set?: (input: {
		service: string;
		name: string;
		value: string;
	}) => Promise<void>;
};

type ConnectionsBackendMode = "auto" | "bun" | "file";

export type SecretStore = {
	get(service: string, account: string): Promise<string | null>;
	set(service: string, account: string, secret: string): Promise<void>;
};

export type ConnectionsBackend = {
	load(providerId: ProviderId): Promise<Credential | null>;
	replaceValidated(providerId: ProviderId, credential: unknown): Promise<void>;
	getStatus(providerId: ProviderId): Promise<ConnectionStatus>;
};

export type ConnectionsStorageOptions = {
	filePath?: string;
	backendMode?: ConnectionsBackendMode;
	bunSecrets?: BunSecretStore | null;
	secretStore?: SecretStore;
};

export const DEFAULT_CONNECTIONS_PATH = join(
	homedir(),
	".wincode",
	"connections.json"
);

export const createConnectionsStore = (
	options: ConnectionsStorageOptions = {}
): ConnectionsBackend => {
	if (options.backendMode === "file") {
		return new FileConnectionsStore(
			options.filePath ?? DEFAULT_CONNECTIONS_PATH
		);
	}

	const secretStore =
		options.secretStore ?? getBunSecretStore(options.bunSecrets);
	if (secretStore === null) {
		return new FileConnectionsStore(
			options.filePath ?? DEFAULT_CONNECTIONS_PATH
		);
	}

	return new SecretConnectionsStore(secretStore);
};

export const migrateLegacyWincodeSession = async (
	readLegacySession: () => Promise<Omit<
		LegacyWincodeSession,
		"resource"
	> | null>,
	store: ConnectionsBackend = createConnectionsStore()
): Promise<boolean> => {
	if ((await store.load("wincode")) !== null) {
		return false;
	}

	const session = await readLegacySession();
	if (session === null) {
		return false;
	}

	const credential: Extract<WincodeCredential, { kind: "oauth-session" }> = {
		...session,
		kind: "oauth-session",
		resource: new URL("/api", session.issuer).href,
	};
	await store.replaceValidated("wincode", credential);
	const restored = (await store.load("wincode")) as Extract<
		WincodeCredential,
		{ kind: "oauth-session" }
	> | null;
	if (
		restored === null ||
		restored.kind !== "oauth-session" ||
		restored.accessToken !== credential.accessToken ||
		restored.clientId !== credential.clientId ||
		restored.expiresAt !== credential.expiresAt ||
		restored.issuer !== credential.issuer ||
		restored.refreshToken !== credential.refreshToken ||
		restored.scope !== credential.scope ||
		restored.tokenType !== credential.tokenType ||
		restored.updatedAt !== credential.updatedAt
	) {
		throw new Error("Legacy wincode session verification failed");
	}

	return true;
};

class SecretConnectionsStore implements ConnectionsBackend {
	private readonly secretStore: SecretStore;
	private readonly lockKey: string;

	constructor(secretStore: SecretStore) {
		this.secretStore = secretStore;
		this.lockKey = `secret:${SERVICE_NAME}:${ACCOUNT_NAME}`;
	}

	load(providerId: ProviderId): Promise<Credential | null> {
		return this.readRecord().then(
			(record) =>
				(record[providerId as keyof ConnectionRecord] ??
					null) as Credential | null
		);
	}

	replaceValidated(providerId: ProviderId, credential: unknown): Promise<void> {
		const validated = validateCredential(providerId, credential);
		return withConnectionsLock(this.lockKey, async () => {
			const record = await this.readRecord();
			const nextRecord = record as Record<ProviderId, Credential | undefined>;
			nextRecord[providerId] = validated;
			await this.writeRecord(record);
		});
	}

	getStatus(providerId: ProviderId): Promise<ConnectionStatus> {
		return this.load(providerId).then((credential) => ({
			connected: credential !== null,
			kind: getCredentialKind(credential),
			providerId,
		}));
	}

	private async readRecord(): Promise<ConnectionRecord> {
		const raw = await this.secretStore.get(SERVICE_NAME, ACCOUNT_NAME);
		if (raw === null) {
			return {};
		}

		return recordSchema.parse(JSON.parse(raw));
	}

	private async writeRecord(record: ConnectionRecord): Promise<void> {
		await this.secretStore.set(
			SERVICE_NAME,
			ACCOUNT_NAME,
			JSON.stringify(record)
		);
	}
}

class FileConnectionsStore implements ConnectionsBackend {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	load(providerId: ProviderId): Promise<Credential | null> {
		return this.readRecord().then(
			(record) =>
				(record[providerId as keyof ConnectionRecord] ??
					null) as Credential | null
		);
	}

	replaceValidated(providerId: ProviderId, credential: unknown): Promise<void> {
		const validated = validateCredential(providerId, credential);
		return withConnectionsLock(`file:${this.path}`, async () => {
			const record = await this.readRecord();
			const nextRecord = record as Record<ProviderId, Credential | undefined>;
			nextRecord[providerId] = validated;
			await this.writeRecord(record);
		});
	}

	getStatus(providerId: ProviderId): Promise<ConnectionStatus> {
		return this.load(providerId).then((credential) => ({
			connected: credential !== null,
			kind: getCredentialKind(credential),
			providerId,
		}));
	}

	private async readRecord(): Promise<ConnectionRecord> {
		try {
			await rejectNonRegularFile(this.path);
			const raw = await readFile(this.path, "utf8");
			return recordSchema.parse(JSON.parse(raw));
		} catch (error) {
			if (isMissingFileError(error)) {
				return {};
			}

			throw error;
		}
	}

	private async writeRecord(record: ConnectionRecord): Promise<void> {
		const directory = dirname(this.path);
		await mkdir(directory, { mode: DIRECTORY_MODE, recursive: true });
		await assertSecureDirectory(directory);
		await chmod(directory, DIRECTORY_MODE);
		await rejectNonRegularFile(this.path);

		const temporaryPath = `${this.path}.${crypto.randomUUID()}.tmp`;
		try {
			await writeFile(temporaryPath, JSON.stringify(record, null, 2), {
				encoding: "utf8",
				flag: "wx",
				mode: FILE_MODE,
			});
			await chmod(temporaryPath, FILE_MODE);
			await rename(temporaryPath, this.path);
			await chmod(this.path, FILE_MODE);
		} catch (error) {
			await rm(temporaryPath, { force: true });
			throw error;
		}
	}
}

const connectionLocks = new Map<string, Promise<void>>();

const withConnectionsLock = async <T>(
	key: string,
	operation: () => Promise<T>
): Promise<T> => {
	const previous = connectionLocks.get(key) ?? Promise.resolve();
	let release: (() => void) | undefined;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	connectionLocks.set(
		key,
		previous.then(
			() => current,
			() => current
		)
	);
	await previous;
	try {
		return await operation();
	} finally {
		release?.();
	}
};

const getBunSecretStore = (
	injectedSecrets?: BunSecretStore | null
): SecretStore | null => {
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
	const { get, set } = secrets;

	return {
		async get(service: string, account: string): Promise<string | null> {
			return get({ service, name: account });
		},
		async set(service: string, account: string, secret: string): Promise<void> {
			await set({ service, name: account, value: secret });
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

const isMissingFileError = (error: unknown): boolean =>
	error instanceof Error && "code" in error && error.code === "ENOENT";

const assertSecureMode = (mode: number, message: string): void => {
	if (process.platform === "win32") {
		return;
	}

	const permissions = mode.toString(8).slice(-3).padStart(3, "0");
	if (permissions[1] !== "0" || permissions[2] !== "0") {
		throw new Error(message);
	}
};

const assertSecureDirectory = async (directory: string): Promise<void> => {
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

const getCredentialKind = (
	credential: Credential | null
): ConnectionStatus["kind"] => {
	if (credential === null) {
		return;
	}

	return credential.kind;
};

export const validateCredential = (
	providerId: ProviderId,
	candidate: unknown
): Credential => credentialSchemas[providerId].parse(candidate) as Credential;
