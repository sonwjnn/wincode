import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	chmod,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretStore } from "./storage";
import {
	createConnectionsStore,
	migrateLegacyWincodeSession,
	validateCredential,
} from "./storage";

const temporaryPaths: string[] = [];
afterEach(async () => {
	for (const path of temporaryPaths.splice(0)) {
		await rm(path, { force: true, recursive: true });
	}
});

const createWincodeSession = () => ({
	accessToken: "access-token",
	clientId: "wincode-cli",
	kind: "oauth-session" as const,
	expiresAt: "2026-07-11T12:00:00.000Z",
	issuer: "https://auth.example.com",
	refreshToken: "refresh-token",
	resource: "https://example.com/api",
	scope: "openid offline_access",
	tokenType: "Bearer" as const,
	updatedAt: "2026-07-11T11:00:00.000Z",
});

const createSecretStore = (): SecretStore & {
	writes: [string, string, string][];
	value: string | null;
} => ({
	writes: [],
	value: null,
	async get() {
		return this.value;
	},
	async set(service, account, secret) {
		this.writes.push([service, account, secret]);
		this.value = secret;
	},
});

describe("connections storage", () => {
	test("missing credential status", async () => {
		const store = createConnectionsStore({ secretStore: createSecretStore() });
		expect(await store.getStatus("openai")).toEqual({
			connected: false,
			kind: undefined,
			providerId: "openai",
		});
		expect(await store.load("openai")).toBeNull();
	});

	test("successful replace and status", async () => {
		const secretStore = createSecretStore();
		const store = createConnectionsStore({ secretStore });
		const credential = { apiKey: "sk-test", kind: "api-key" as const };

		await store.replaceValidated("openai", credential);

		expect(await store.load("openai")).toEqual(credential);
		expect(await store.getStatus("openai")).toEqual({
			connected: true,
			kind: "api-key",
			providerId: "openai",
		});
		expect(secretStore.writes).toHaveLength(1);
	});

	test("invalid schema rejected", () => {
		expect(() =>
			validateCredential("wincode", { kind: "oauth-session" })
		).toThrow();
		expect(() => validateCredential("openai", { apiKey: "" })).toThrow();
	});

	test("replaceValidated rejects pairing mismatch", async () => {
		const store = createConnectionsStore({ secretStore: createSecretStore() });
		await expect(
			store.replaceValidated("openai", { apiKey: "sk-test", kind: "api-key" })
		).resolves.toBeUndefined();
		await expect(
			Promise.resolve().then(() =>
				store.replaceValidated("openai", {
					accessToken: "oops",
					clientId: "wincode-cli",
					kind: "oauth-session",
					expiresAt: "2026-07-11T12:00:00.000Z",
					issuer: "https://auth.example.com",
					refreshToken: "refresh-token",
					scope: "openid",
					tokenType: "Bearer",
					updatedAt: "2026-07-11T11:00:00.000Z",
				})
			)
		).rejects.toThrow();
	});

	test("bun store only selected when both api methods exist", () => {
		const store = createConnectionsStore({
			backendMode: "auto",
			bunSecrets: {
				get: mock(() => Promise.resolve(null)),
				set: mock(async () => undefined),
			},
		});
		expect(store).toBeDefined();
	});

	test("partial bun api falls back to file backend", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wincode-connections-"));
		temporaryPaths.push(directory);
		const path = join(directory, "connections.json");
		const store = createConnectionsStore({
			backendMode: "auto",
			filePath: path,
			bunSecrets: { get: mock(() => Promise.resolve(null)) },
		});
		await store.replaceValidated("openai", {
			apiKey: "sk-test",
			kind: "api-key",
		});
		expect(await store.load("openai")).toEqual({
			apiKey: "sk-test",
			kind: "api-key",
		});
	});

	test("file fallback permissions and non-regular target", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wincode-connections-"));
		temporaryPaths.push(directory);
		const path = join(directory, "connections.json");
		const store = createConnectionsStore({
			filePath: path,
			backendMode: "file",
		});
		const credential = { apiKey: "sk-test", kind: "api-key" as const };

		await store.replaceValidated("anthropic", credential);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			anthropic: credential,
		});
		expect((await stat(directory)).mode.toString(8).slice(-3)).toBe("700");
		expect((await stat(path)).mode.toString(8).slice(-3)).toBe("600");

		const linkPath = join(directory, "link.json");
		await symlink(path, linkPath);
		await expect(
			createConnectionsStore({
				filePath: linkPath,
				backendMode: "file",
			}).replaceValidated("anthropic", credential)
		).rejects.toThrow("Refusing to replace non-regular connections file");
	});

	test("file reader rejects insecure existing permissions", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wincode-connections-"));
		temporaryPaths.push(directory);
		const path = join(directory, "connections.json");
		await writeFile(
			path,
			JSON.stringify({ openai: { apiKey: "sk-test", kind: "api-key" } })
		);
		await chmod(path, 0o644);
		await expect(
			createConnectionsStore({ filePath: path, backendMode: "file" }).load(
				"openai"
			)
		).rejects.toThrow("Refusing insecure connections file permissions");
	});

	test("primary backend errors do not fall back", async () => {
		const error = new Error("denied");
		const secretStore: SecretStore = {
			async get() {
				throw error;
			},
			async set() {
				throw error;
			},
		};
		const store = createConnectionsStore({ secretStore });
		await expect(store.load("openai")).rejects.toThrow("denied");
	});

	test("concurrent store instances preserve both provider writes", async () => {
		let releaseFirstWrite: (() => void) | undefined;
		const firstWriteStarted = new Promise<void>((resolve) => {
			releaseFirstWrite = resolve;
		});
		const secretStore = {
			value: null as string | null,
			writes: [] as [string, string, string][],
			async get() {
				return this.value;
			},
			async set(service: string, account: string, secret: string) {
				this.writes.push([service, account, secret]);
				if (this.writes.length === 1) {
					await firstWriteStarted;
				}
				this.value = secret;
			},
		};
		const storeA = createConnectionsStore({ secretStore });
		const storeB = createConnectionsStore({ secretStore });
		const first = storeA.replaceValidated("openai", {
			apiKey: "sk-openai",
			kind: "api-key",
		});
		const second = storeB.replaceValidated("anthropic", {
			apiKey: "sk-anthropic",
			kind: "api-key",
		});

		await Promise.resolve();
		releaseFirstWrite?.();
		await Promise.all([first, second]);

		expect(await storeA.load("openai")).toEqual({
			apiKey: "sk-openai",
			kind: "api-key",
		});
		expect(await storeA.load("anthropic")).toEqual({
			apiKey: "sk-anthropic",
			kind: "api-key",
		});
	});

	test("legacy wincode migration is idempotent and preserves legacy data", async () => {
		const secretStore = createSecretStore();
		const store = createConnectionsStore({ secretStore });
		let calls = 0;
		const reader = async () => {
			calls += 1;
			const { resource: _resource, ...legacySession } = createWincodeSession();
			return legacySession;
		};

		expect(await migrateLegacyWincodeSession(reader, store)).toBe(true);
		expect(await migrateLegacyWincodeSession(reader, store)).toBe(false);
		expect(calls).toBe(1);
		expect(await store.load("wincode")).toEqual({
			...createWincodeSession(),
			resource: "https://auth.example.com/api",
		});
	});

	test("legacy migration no-op when destination exists", async () => {
		const secretStore = createSecretStore();
		const store = createConnectionsStore({ secretStore });
		await store.replaceValidated("wincode", createWincodeSession());
		const reader = mock(async () => createWincodeSession());
		expect(await migrateLegacyWincodeSession(reader, store)).toBe(false);
		expect(reader).not.toHaveBeenCalled();
	});

	test("file fallback path uses owner-only dir", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wincode-connections-"));
		temporaryPaths.push(directory);
		const path = join(directory, "nested", "connections.json");
		const store = createConnectionsStore({
			filePath: path,
			backendMode: "file",
		});
		await store.replaceValidated("openai", {
			apiKey: "sk-test",
			kind: "api-key",
		});
		expect(await store.load("openai")).toEqual({
			apiKey: "sk-test",
			kind: "api-key",
		});
	});
});
