import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createLegacyCredentialCleanupStore,
	type LegacyCredentialCleanupEntry,
	type LegacyCredentialPlatformStore,
	legacyCredentialProviderIds,
} from "@wincode/ai/connections/legacy-cleanup";

type SecretStore = LegacyCredentialPlatformStore;

const secretKey = (service: string, account: string): string =>
	`${service}/${account}`;

const createFakeSecretStore = (
	initialValues: ReadonlyMap<string, string> = new Map()
): {
	deleteCalls: string[];
	getCalls: string[];
	values: Map<string, string>;
	store: SecretStore;
} => {
	const values = new Map(initialValues);
	const deleteCalls: string[] = [];
	const getCalls: string[] = [];
	return {
		deleteCalls,
		getCalls,
		values,
		store: {
			async delete(service, account) {
				deleteCalls.push(secretKey(service, account));
				return values.delete(secretKey(service, account));
			},
			async get(service, account) {
				getCalls.push(secretKey(service, account));
				return values.get(secretKey(service, account)) ?? null;
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

const entryFor = (
	entries: readonly LegacyCredentialCleanupEntry[],
	providerId: LegacyCredentialCleanupEntry["providerId"]
): LegacyCredentialCleanupEntry | undefined =>
	entries.find((entry) => entry.providerId === providerId);

test("creating the dormant cleanup store does not inspect or delete either legacy backend", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-legacy-cleanup-dormant-")
	);
	const account = secretKey("wincode", "connections-v2:openai");
	const fake = createFakeSecretStore(new Map([[account, "fake-legacy-key"]]));
	const filePath = legacyFilePath(root, "openai");
	try {
		await writeLegacyCredentialFile(root, "openai", "fake-legacy-file");
		createLegacyCredentialCleanupStore({
			fileRoot: root,
			secretStore: fake.store,
		});

		expect(fake.getCalls).toEqual([]);
		expect(fake.deleteCalls).toEqual([]);
		expect(fake.values.has(account)).toBe(true);
		expect(await fs.lstat(filePath).then((stats) => stats.isFile())).toBe(true);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("legacy cleanup deletes an OS-only credential and verifies absence without returning it", async () => {
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
		expect(entryFor(report, "openai")).toEqual({
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
		expect(entryFor(report, "anthropic")).toEqual({
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

		expect(await Bun.file(targetCredentialPath).text()).toContain(fakeSecret);
		expect(entryFor(report, "openai")).toEqual({
			providerId: "openai",
			platform: "not-configured",
			file: "unverified",
		});
	} finally {
		await fs.rm(root, { force: true, recursive: true });
		await fs.rm(target, { force: true, recursive: true });
	}
});

test("legacy cleanup removes both credential copies but leaves Provider SDK credentials and Session attachments unchanged", async () => {
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
		expect(await Bun.file(attachmentPath).text()).toBe("fake attachment");
		expect(entryFor(report, "google")).toEqual({
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
		expect(entryFor(report, "openai")).toEqual({
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
	};
	try {
		const cleanup = createLegacyCredentialCleanupStore({
			fileRoot: root,
			secretStore,
		});
		const report = await cleanup.removeAllAndVerify();

		expect(entryFor(report, "openai")).toEqual({
			providerId: "openai",
			platform: "unverified",
			file: "absent",
		});
		expect(JSON.stringify(report)).not.toContain(fakeSecret);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("partial legacy cleanup can be retried idempotently without restoring removed credentials", async () => {
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
		expect(entryFor(partial, "openai")).toMatchObject({
			platform: "deleted",
		});
		expect(entryFor(partial, "google")).toMatchObject({
			platform: "unverified",
		});

		googleDeleteFails = false;
		const retried = await cleanup.removeAllAndVerify();
		expect(fake.values.size).toBe(0);
		expect(entryFor(retried, "openai")).toMatchObject({
			platform: "absent",
		});
		expect(entryFor(retried, "google")).toMatchObject({
			platform: "deleted",
		});
		const repeated = await cleanup.removeAllAndVerify();
		expect(repeated.every((entry) => entry.platform === "absent")).toBe(true);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("legacy cleanup remains scoped to the pre-SDK Connection Provider IDs", () => {
	expect(legacyCredentialProviderIds).toEqual([
		"anthropic",
		"google",
		"openai",
		"opencode-go",
	]);
});
