import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createLegacyCredentialCleanupStore,
	type LegacyCredentialPlatformStore,
} from "@wincode/ai/connections/legacy-cleanup";
import { CredentialVaultV2 } from "../src/connections/v2-credential-vault";

type SecretStore = LegacyCredentialPlatformStore;

/** The shape a headless Linux host reports: a secret backend that cannot serve. */
const unusableSecretStore = {
	get: async (): Promise<string | null> => {
		throw new Error("libsecret not available");
	},
	set: async (): Promise<void> => {
		throw new Error("libsecret not available");
	},
};

test("an unusable OS secret backend falls back to the vault's file store", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-credential-vault-")
	);
	try {
		const vault = new CredentialVaultV2({
			fileRoot: root,
			secretStore: unusableSecretStore,
		});

		expect(await vault.load("anthropic")).toBeNull();
		await vault.replaceValidated("anthropic", {
			apiKey: "sk-ant-test",
			kind: "api-key",
		});
		expect(await vault.load("anthropic")).toEqual({
			apiKey: "sk-ant-test",
			kind: "api-key",
		});
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

const secretKey = (service: string, account: string): string =>
	`${service}/${account}`;

const createFakeSecretStore = (
	initialValues: ReadonlyMap<string, string> = new Map()
): { values: Map<string, string>; store: SecretStore } => {
	const values = new Map(initialValues);
	return {
		values,
		store: {
			async delete(service, account) {
				return values.delete(secretKey(service, account));
			},
			async get(service, account) {
				return values.get(secretKey(service, account)) ?? null;
			},
			async set(service, account, secret) {
				values.set(secretKey(service, account), secret);
			},
		},
	};
};

const legacyFilePath = (fileRoot: string, providerId: string): string =>
	path.join(fileRoot, ".wincode", "connections-v2", `${providerId}.json`);

const writeLegacyCredentialFile = async (
	fileRoot: string,
	providerId: string,
	value: string
): Promise<void> => {
	const filePath = legacyFilePath(fileRoot, providerId);
	await fs.mkdir(path.dirname(filePath), { mode: 0o700, recursive: true });
	await fs.writeFile(filePath, value, { encoding: "utf8", mode: 0o600 });
};

test("legacy cleanup deletes an OS-only credential and verifies absence", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-legacy-credential-os-only-")
	);
	const account = secretKey("wincode", "connections-v2:openai");
	const secret = "fake-os-only-legacy-key";
	const fake = createFakeSecretStore(new Map([[account, secret]]));
	try {
		const cleanup = createLegacyCredentialCleanupStore({
			fileRoot: root,
			secretStore: fake.store,
		});
		const report = await cleanup.removeAllAndVerify();

		expect(fake.values.has(account)).toBe(false);
		expect(report.find((entry) => entry.providerId === "openai")).toEqual({
			providerId: "openai",
			platform: "deleted",
			file: "absent",
		});
		expect(JSON.stringify(report)).not.toContain(secret);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("legacy cleanup deletes a file-only credential without configuring a platform store", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-legacy-credential-file-only-")
	);
	const filePath = legacyFilePath(root, "anthropic");
	try {
		await writeLegacyCredentialFile(
			root,
			"anthropic",
			JSON.stringify({ apiKey: "fake-file-only-legacy-key" })
		);
		const cleanup = createLegacyCredentialCleanupStore({ fileRoot: root });
		const report = await cleanup.removeAllAndVerify();

		expect(await fs.lstat(filePath).catch(() => undefined)).toBeUndefined();
		expect(report.find((entry) => entry.providerId === "anthropic")).toEqual({
			providerId: "anthropic",
			platform: "not-configured",
			file: "deleted",
		});
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("legacy cleanup refuses a symlinked .wincode directory without deleting its target credential", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-legacy-credential-symlink-root-")
	);
	const target = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-legacy-credential-symlink-target-")
	);
	const targetCredentialPath = path.join(
		target,
		"connections-v2",
		"openai.json"
	);
	const fakeSecret = "fake-symlink-target-credential";
	try {
		await fs.mkdir(path.dirname(targetCredentialPath), {
			mode: 0o700,
			recursive: true,
		});
		await fs.writeFile(
			targetCredentialPath,
			JSON.stringify({ apiKey: fakeSecret }),
			{ encoding: "utf8", mode: 0o600 }
		);
		await fs.symlink(target, path.join(root, ".wincode"), "dir");

		const cleanup = createLegacyCredentialCleanupStore({ fileRoot: root });
		const report = await cleanup.removeAllAndVerify();

		expect(await fs.readFile(targetCredentialPath, "utf8")).toContain(
			fakeSecret
		);
		expect(report.find((entry) => entry.providerId === "openai")).toEqual({
			providerId: "openai",
			platform: "not-configured",
			file: "unverified",
		});
	} finally {
		await fs.rm(root, { force: true, recursive: true });
		await fs.rm(target, { force: true, recursive: true });
	}
});

test("legacy cleanup removes both credential copies but leaves Session attachments unchanged", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-legacy-credential-both-")
	);
	const account = secretKey("wincode", "connections-v2:google");
	const providerSdkAccount = secretKey(
		"wincode-provider-sdk",
		"provider-sdk:openrouter"
	);
	const attachmentPath = path.join(root, ".wincode", "attachments", "keep.bin");
	const fake = createFakeSecretStore(
		new Map([
			[account, "fake-duplicate-legacy-key"],
			[providerSdkAccount, "fake-provider-sdk-key"],
		])
	);
	try {
		await writeLegacyCredentialFile(
			root,
			"google",
			JSON.stringify({ apiKey: "fake-duplicate-legacy-key" })
		);
		await fs.mkdir(path.dirname(attachmentPath), {
			mode: 0o700,
			recursive: true,
		});
		await fs.writeFile(attachmentPath, "fake attachment", { mode: 0o600 });
		const cleanup = createLegacyCredentialCleanupStore({
			fileRoot: root,
			secretStore: fake.store,
		});
		const report = await cleanup.removeAllAndVerify();

		expect(fake.values.has(account)).toBe(false);
		expect(fake.values.get(providerSdkAccount)).toBe("fake-provider-sdk-key");
		expect(
			await fs.lstat(legacyFilePath(root, "google")).catch(() => undefined)
		).toBeUndefined();
		expect(await fs.readFile(attachmentPath, "utf8")).toBe("fake attachment");
		expect(report.find((entry) => entry.providerId === "google")).toEqual({
			providerId: "google",
			platform: "deleted",
			file: "deleted",
		});
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("legacy cleanup reports inaccessible OS storage while still removing the file copy", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-legacy-credential-inaccessible-")
	);
	const filePath = legacyFilePath(root, "openai");
	const inaccessible: SecretStore = {
		get: async () => {
			throw new Error("fake platform store unavailable");
		},
		set: async () => {
			throw new Error("fake platform store unavailable");
		},
	};
	try {
		await writeLegacyCredentialFile(
			root,
			"openai",
			JSON.stringify({ apiKey: "fake-inaccessible-legacy-key" })
		);
		const cleanup = createLegacyCredentialCleanupStore({
			fileRoot: root,
			secretStore: inaccessible,
		});
		const report = await cleanup.removeAllAndVerify();

		expect(await fs.lstat(filePath).catch(() => undefined)).toBeUndefined();
		expect(report.find((entry) => entry.providerId === "openai")).toEqual({
			providerId: "openai",
			platform: "unverified",
			file: "deleted",
		});
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("legacy cleanup requires OS readback to verify a successful delete", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-legacy-credential-verification-")
	);
	const fakeSecret = "fake-unverified-legacy-key";
	const secretStore: SecretStore = {
		delete: async () => true,
		get: async () => fakeSecret,
		set: async () => undefined,
	};
	try {
		const cleanup = createLegacyCredentialCleanupStore({
			fileRoot: root,
			secretStore,
		});
		const report = await cleanup.removeAllAndVerify();

		expect(report.find((entry) => entry.providerId === "openai")).toEqual({
			providerId: "openai",
			platform: "unverified",
			file: "absent",
		});
		expect(JSON.stringify(report)).not.toContain(fakeSecret);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("a partial legacy cleanup can be retried idempotently without restoring removed credentials", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-legacy-credential-partial-retry-")
	);
	const openAiAccount = secretKey("wincode", "connections-v2:openai");
	const googleAccount = secretKey("wincode", "connections-v2:google");
	const fake = createFakeSecretStore(
		new Map([
			[openAiAccount, "fake-openai-legacy-key"],
			[googleAccount, "fake-google-legacy-key"],
		])
	);
	let googleDeleteFails = true;
	const secretStore: SecretStore = {
		get: (service, account) => fake.store.get(service, account),
		set: (service, account, secret) => fake.store.set(service, account, secret),
		async delete(service, account) {
			if (account === "connections-v2:google" && googleDeleteFails) {
				throw new Error("fake one-time platform delete failure");
			}
			return fake.values.delete(secretKey(service, account));
		},
	};
	try {
		const cleanup = createLegacyCredentialCleanupStore({
			fileRoot: root,
			secretStore,
		});
		const partial = await cleanup.removeAllAndVerify();
		expect(fake.values.has(openAiAccount)).toBe(false);
		expect(fake.values.has(googleAccount)).toBe(true);
		expect(
			partial.find((entry) => entry.providerId === "openai")
		).toMatchObject({
			platform: "deleted",
		});
		expect(
			partial.find((entry) => entry.providerId === "google")
		).toMatchObject({
			platform: "unverified",
		});

		googleDeleteFails = false;
		const retried = await cleanup.removeAllAndVerify();
		expect(fake.values.size).toBe(0);
		expect(
			retried.find((entry) => entry.providerId === "openai")
		).toMatchObject({
			platform: "absent",
		});
		expect(
			retried.find((entry) => entry.providerId === "google")
		).toMatchObject({
			platform: "deleted",
		});
		const repeated = await cleanup.removeAllAndVerify();
		expect(repeated.every((entry) => entry.platform === "absent")).toBe(true);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});
