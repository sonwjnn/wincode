import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isError, isNull } from "@wincode/utils";

const SERVICE_NAME = "wincode";

export const legacyCredentialProviderIds = [
	"anthropic",
	"google",
	"openai",
	"opencode-go",
] as const;

export type LegacyCredentialProviderId =
	(typeof legacyCredentialProviderIds)[number];

export type LegacyCredentialPlatformStore = Readonly<{
	delete?: (service: string, account: string) => Promise<boolean>;
	get(service: string, account: string): Promise<string | null>;
}>;

export type LegacyCredentialBackendStatus =
	| "not-configured"
	| "absent"
	| "deleted"
	| "unverified";

export type LegacyCredentialCleanupEntry = Readonly<{
	providerId: LegacyCredentialProviderId;
	platform: LegacyCredentialBackendStatus;
	file: LegacyCredentialBackendStatus;
}>;

export type LegacyCredentialCleanupStoreOptions = Readonly<{
	fileRoot?: string;
	secretStore?: LegacyCredentialPlatformStore;
}>;

export type LegacyCredentialCleanupStore = Readonly<{
	removeAllAndVerify(): Promise<readonly LegacyCredentialCleanupEntry[]>;
}>;

type BunSecretStore = Readonly<{
	delete?: (input: { service: string; name: string }) => Promise<boolean>;
	get?: (input: { service: string; name: string }) => Promise<string | null>;
}>;

/**
 * Creates the temporary destructive capability for the final migration gate.
 * Creation does not read or delete credentials; cleanup runs only when
 * removeAllAndVerify is explicitly invoked.
 */
export const createLegacyCredentialCleanupStore = (
	options: LegacyCredentialCleanupStoreOptions = {}
): LegacyCredentialCleanupStore => {
	const secretStore =
		options.secretStore ??
		(options.fileRoot === undefined ? getBunSecretStore() : null);
	const fileRoot = options.fileRoot ?? os.homedir();
	return Object.freeze({
		async removeAllAndVerify(): Promise<
			readonly LegacyCredentialCleanupEntry[]
		> {
			const entries: LegacyCredentialCleanupEntry[] = [];
			for (const providerId of legacyCredentialProviderIds) {
				const platform = await removeLegacyPlatformCredential(
					secretStore,
					providerId
				);
				const file = await removeLegacyFileCredential(providerId, fileRoot);
				entries.push({ providerId, platform, file });
			}
			return entries;
		},
	});
};

const connectionFilePath = (
	providerId: LegacyCredentialProviderId,
	fileRoot: string
): string =>
	path.join(fileRoot, ".wincode", "connections-v2", `${providerId}.json`);

const getBunSecretStore = (): LegacyCredentialPlatformStore | null => {
	const secrets = (
		globalThis as typeof globalThis & { Bun?: { secrets?: BunSecretStore } }
	).Bun?.secrets;
	const getSecret = secrets?.get;
	const deleteSecret = secrets?.delete;
	if (getSecret === undefined) {
		return null;
	}
	return {
		get: (service, account) =>
			Promise.resolve(getSecret({ service, name: account }) ?? null),
		...(deleteSecret === undefined
			? {}
			: {
					delete: (service: string, account: string) =>
						deleteSecret({ service, name: account }),
				}),
	};
};

const removeLegacyPlatformCredential = async (
	secretStore: LegacyCredentialPlatformStore | null,
	providerId: LegacyCredentialProviderId
): Promise<LegacyCredentialBackendStatus> => {
	if (isNull(secretStore)) {
		return "not-configured";
	}
	const account = `connections-v2:${providerId}`;
	try {
		if (isNull(await secretStore.get(SERVICE_NAME, account))) {
			return "absent";
		}
		if (secretStore.delete === undefined) {
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
	providerId: LegacyCredentialProviderId,
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

const assertSecurePath = async (targetPath: string): Promise<void> => {
	const wincodeDirectory = path.dirname(path.dirname(targetPath));
	const connectionsDirectory = path.dirname(targetPath);
	await assertSecureDirectoryChain(wincodeDirectory);
	await assertSecureDirectoryChain(connectionsDirectory);
	await rejectNonRegularFile(targetPath);
};

const assertSecureDirectoryChain = async (directory: string): Promise<void> => {
	try {
		const stats = await fs.lstat(directory);
		if (!stats.isDirectory()) {
			throw new Error(
				`Refusing insecure legacy credential directory: ${directory}`
			);
		}
		assertSecureMode(
			stats.mode,
			`Refusing insecure legacy credential directory permissions: ${directory}`
		);
	} catch (error) {
		if (isMissingFileError(error)) {
			return;
		}
		throw error;
	}
};

const rejectNonRegularFile = async (filePath: string): Promise<void> => {
	try {
		const stats = await fs.lstat(filePath);
		if (!stats.isFile()) {
			throw new Error(
				`Refusing to remove non-regular legacy credential: ${filePath}`
			);
		}
		assertSecureMode(
			stats.mode,
			`Refusing insecure legacy credential permissions: ${filePath}`
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

const isMissingFileError = (error: unknown): boolean =>
	isError(error) && "code" in error && error.code === "ENOENT";
