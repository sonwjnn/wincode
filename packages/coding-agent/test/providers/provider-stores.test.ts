import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CredentialStore, ProviderModel } from "@wincode/ai";
import {
	createProviderSdkCredentialStore,
	createProviderSdkModelStore,
	getProviderSdkStores,
} from "@/modules/providers/provider-stores";

test("separate Home and Host Provider compositions share app-owned user stores", () => {
	const userDataDir = path.join(
		os.tmpdir(),
		`wincode-provider-store-sharing-${crypto.randomUUID()}`
	);
	const homeStores = getProviderSdkStores({ userDataDir });
	const sessionStores = getProviderSdkStores({ userDataDir });

	expect(sessionStores.credentialStore).toBe(homeStores.credentialStore);
	expect(sessionStores.modelStore).toBe(homeStores.modelStore);
});

const saveCredential = async (
	store: CredentialStore,
	providerId: string,
	credential: unknown
): Promise<unknown> => await store.modify(providerId, () => credential);

const savedModels: readonly ProviderModel[] = [
	{
		capabilities: ["text", "tools"],
		limits: { contextWindowTokens: 32_000, maxOutputTokens: 4000 },
		modelId: "vendor/saved-model",
		pricing: {
			inputPerMillionTokensUsd: 1,
			outputPerMillionTokensUsd: 2,
		},
		protocolId: "openai-compatible",
		providerId: "openrouter",
	},
];

test("Provider SDK credentials and Known Models are user-scoped, reloadable, and cancellation-safe", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-provider-stores-")
	);
	const userOne = path.join(root, "user-one");
	const userTwo = path.join(root, "user-two");
	const credentialsOne = createProviderSdkCredentialStore({
		platformStore: null,
		userDataDir: userOne,
	});
	const modelsOne = createProviderSdkModelStore({ userDataDir: userOne });
	const credentialsTwo = createProviderSdkCredentialStore({
		platformStore: null,
		userDataDir: userTwo,
	});
	const modelsTwo = createProviderSdkModelStore({ userDataDir: userTwo });

	try {
		await saveCredential(credentialsOne, "openrouter", {
			apiKey: "fake-user-one-key",
			kind: "api-key",
		});
		await modelsOne.set("openrouter", savedModels, { signal: undefined });

		const restartedCredentials = createProviderSdkCredentialStore({
			platformStore: null,
			userDataDir: userOne,
		});
		const restartedModels = createProviderSdkModelStore({
			userDataDir: userOne,
		});
		expect(await restartedCredentials.read("openrouter")).toEqual({
			apiKey: "fake-user-one-key",
			kind: "api-key",
		});
		expect(await restartedCredentials.list()).toEqual([
			{ providerId: "openrouter", type: "api-key" },
		]);
		expect(await restartedModels.get("openrouter")).toEqual(savedModels);
		expect(await credentialsTwo.read("openrouter")).toBeUndefined();
		expect(await modelsTwo.get("openrouter")).toBeUndefined();

		const cancelled = new AbortController();
		cancelled.abort(new DOMException("snapshot cancelled", "AbortError"));
		await expect(
			restartedModels.set("openrouter", [], { signal: cancelled.signal })
		).rejects.toThrow("snapshot cancelled");
		expect(await restartedModels.get("openrouter")).toEqual(savedModels);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("legacy secure-file credentials migrate to secret-free provider metadata", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-provider-store-index-migration-")
	);
	const userDataDir = path.join(root, "user");
	const initialStore = createProviderSdkCredentialStore({
		platformStore: null,
		userDataDir,
	});
	const secret = "legacy-file-provider-secret";
	try {
		await saveCredential(initialStore, "openrouter", {
			apiKey: secret,
			kind: "api-key",
		});
		const indexPath = path.join(
			userDataDir,
			"provider-sdk-credential-index.json"
		);
		await fs.rm(indexPath);

		const migratedStore = createProviderSdkCredentialStore({
			platformStore: null,
			userDataDir,
		});
		const metadata = await migratedStore.list();
		expect(metadata).toEqual([{ providerId: "openrouter", type: "api-key" }]);
		expect(JSON.stringify(metadata)).not.toContain(secret);
		expect(await Bun.file(indexPath).exists()).toBe(true);
		expect(await migratedStore.read("openrouter")).toEqual({
			apiKey: secret,
			kind: "api-key",
		});
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("separate processes serialize persistent credential read-modify-write operations", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-provider-store-process-lock-")
	);
	const userDataDir = path.join(root, "user");
	const firstStore = createProviderSdkCredentialStore({
		platformStore: null,
		userDataDir,
	});
	const updateStarted = Promise.withResolvers<void>();
	const finishFirstUpdate = Promise.withResolvers<void>();
	const childReadyPath = path.join(root, "child-ready");
	const childSource = `
import { createProviderSdkCredentialStore } from "./packages/coding-agent/modules/providers/provider-stores.ts";
const store = createProviderSdkCredentialStore({ platformStore: null, userDataDir: process.env.WINCODE_PROVIDER_STORE_TEST_DIR });
await Bun.write(process.env.WINCODE_PROVIDER_STORE_TEST_READY, "ready");
await store.modify("openai", (credential) => {
  if (typeof credential !== "object" || credential === null) throw new Error("missing credential");
  const current = credential as Record<string, unknown>;
  return { ...current, revision: Number(current.revision) + 1 };
});
`;
	const child = Bun.spawn([process.execPath, "-e", childSource], {
		cwd: process.cwd(),
		env: {
			...process.env,
			WINCODE_PROVIDER_STORE_TEST_DIR: userDataDir,
			WINCODE_PROVIDER_STORE_TEST_READY: childReadyPath,
		},
		stderr: "pipe",
		stdout: "pipe",
	});
	try {
		await saveCredential(firstStore, "openai", {
			kind: "oauth-session",
			revision: 0,
		});
		const firstUpdate = firstStore.modify("openai", async (credential) => {
			updateStarted.resolve();
			await finishFirstUpdate.promise;
			if (typeof credential !== "object" || credential === null) {
				throw new Error("The first process did not read the credential.");
			}
			const current = credential as Record<string, unknown>;
			return { ...current, revision: Number(current.revision) + 1 };
		});
		await updateStarted.promise;

		let childReady = false;
		for (let attempt = 0; attempt < 500; attempt += 1) {
			if (await Bun.file(childReadyPath).exists()) {
				childReady = true;
				break;
			}
			await Bun.sleep(10);
		}
		expect(childReady).toBe(true);
		await Bun.sleep(50);
		finishFirstUpdate.resolve();
		await firstUpdate;
		const childExitCode = await child.exited;
		const childStderr = await new Response(
			child.stderr as ReadableStream<Uint8Array>
		).text();
		expect(childExitCode).toBe(0);
		expect(childStderr).toBe("");
		expect(await firstStore.read("openai")).toMatchObject({ revision: 2 });
	} finally {
		finishFirstUpdate.resolve();
		child.kill();
		await child.exited;
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("Provider credentials fall back to the secure file after platform-store recovery reports no account", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-provider-credential-recovery-")
	);
	const userDataDir = path.join(root, "user");
	const credential = { apiKey: "fake-outage-key", kind: "api-key" } as const;
	const unavailablePlatformStore = {
		delete: async () => {
			throw new Error("fake platform store unavailable");
		},
		get: async () => {
			throw new Error("fake platform store unavailable");
		},
		set: async () => {
			throw new Error("fake platform store unavailable");
		},
	};
	try {
		const duringOutage = createProviderSdkCredentialStore({
			platformStore: unavailablePlatformStore,
			userDataDir,
		});
		await saveCredential(duringOutage, "openrouter", credential);

		const afterRestart = createProviderSdkCredentialStore({
			platformStore: {
				delete: async () => false,
				get: async () => null,
				set: async () => undefined,
			},
			userDataDir,
		});
		expect(await afterRestart.read("openrouter")).toEqual(credential);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("platform credential logout fails closed after a transient platform read failure", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-provider-credential-platform-delete-")
	);
	const userDataDir = path.join(root, "user");
	const credential = { apiKey: "fake-platform-delete-key", kind: "api-key" };
	const fallback = createProviderSdkCredentialStore({
		platformStore: null,
		userDataDir,
	});
	const platformValues = new Map<string, string>();
	const platformKey = (service: string, name: string): string =>
		`${service}:${name}`;
	let platformAvailable = false;
	const platformStore = {
		delete: async ({ name, service }: { name: string; service: string }) => {
			if (!platformAvailable) {
				throw new Error("platform store unavailable");
			}
			return platformValues.delete(platformKey(service, name));
		},
		get: async ({ name, service }: { name: string; service: string }) => {
			if (!platformAvailable) {
				throw new Error("platform store unavailable");
			}
			return platformValues.get(platformKey(service, name)) ?? null;
		},
		set: async ({
			name,
			service,
			value,
		}: {
			name: string;
			service: string;
			value: string;
		}) => {
			if (!platformAvailable) {
				throw new Error("platform store unavailable");
			}
			platformValues.set(platformKey(service, name), value);
		},
	};
	try {
		await saveCredential(fallback, "openrouter", credential);
		platformValues.set(
			platformKey("wincode-provider-sdk", "provider-sdk:openrouter"),
			JSON.stringify(credential)
		);
		const duringOutage = createProviderSdkCredentialStore({
			platformStore,
			userDataDir,
		});
		await expect(duringOutage.delete("openrouter")).rejects.toThrow(
			"Could not delete Provider SDK credential from the platform secret store."
		);
		expect(await duringOutage.list()).toEqual([
			{ providerId: "openrouter", type: "api-key" },
		]);

		platformAvailable = true;
		const afterRecovery = createProviderSdkCredentialStore({
			platformStore,
			userDataDir,
		});
		expect(await afterRecovery.read("openrouter")).toEqual(credential);
		await duringOutage.delete("openrouter");
		expect(await duringOutage.read("openrouter")).toBeUndefined();
		expect(await afterRecovery.read("openrouter")).toBeUndefined();
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("fallback credentials supersede stale platform values after a write outage", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-provider-credential-write-outage-")
	);
	const userDataDir = path.join(root, "user");
	const platformValues = new Map<string, string>();
	const platformKey = (service: string, name: string): string =>
		`${service}:${name}`;
	const oldCredential = { apiKey: "old-platform-key", kind: "api-key" };
	const updatedCredential = { apiKey: "new-fallback-key", kind: "api-key" };
	platformValues.set(
		platformKey("wincode-provider-sdk", "provider-sdk:openrouter"),
		JSON.stringify(oldCredential)
	);
	let platformWritable = false;
	const platformStore = {
		delete: async ({ name, service }: { name: string; service: string }) =>
			platformValues.delete(platformKey(service, name)),
		get: async ({ name, service }: { name: string; service: string }) =>
			platformValues.get(platformKey(service, name)) ?? null,
		set: async ({
			name,
			service,
			value,
		}: {
			name: string;
			service: string;
			value: string;
		}) => {
			if (!platformWritable) {
				throw new Error("platform store unavailable");
			}
			platformValues.set(platformKey(service, name), value);
		},
	};
	const store = createProviderSdkCredentialStore({
		platformStore,
		userDataDir,
	});
	try {
		await store.modify("openrouter", () => updatedCredential);
		expect(await store.read("openrouter")).toEqual(updatedCredential);
		const restarted = createProviderSdkCredentialStore({
			platformStore,
			userDataDir,
		});
		expect(await restarted.read("openrouter")).toEqual(updatedCredential);

		platformWritable = true;
		await store.modify("openrouter", (credential) => credential);
		expect(
			platformValues.get(
				platformKey("wincode-provider-sdk", "provider-sdk:openrouter")
			)
		).toBe(JSON.stringify(updatedCredential));
		expect(await restarted.read("openrouter")).toEqual(updatedCredential);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("successful platform credential writes and deletes clear stale secure-file entries", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-provider-credential-reconcile-")
	);
	const userDataDir = path.join(root, "user");
	const fallback = createProviderSdkCredentialStore({
		platformStore: null,
		userDataDir,
	});
	const staleCredential = {
		apiKey: "fake-stale-key",
		kind: "api-key",
	} as const;
	const replacementCredential = {
		apiKey: "fake-replacement-key",
		kind: "api-key",
	} as const;
	const platformValues = new Map<string, string>();
	const platformKey = (service: string, name: string): string =>
		`${service}:${name}`;
	try {
		await saveCredential(fallback, "openrouter", staleCredential);
		await saveCredential(fallback, "anthropic", staleCredential);

		const recovered = createProviderSdkCredentialStore({
			platformStore: {
				delete: async ({ name, service }) =>
					platformValues.delete(platformKey(service, name)),
				get: async ({ name, service }) =>
					platformValues.get(platformKey(service, name)) ?? null,
				set: async ({ name, service, value }) => {
					platformValues.set(platformKey(service, name), value);
				},
			},
			userDataDir,
		});
		await saveCredential(recovered, "openrouter", replacementCredential);
		await recovered.delete("anthropic");

		const laterOutage = createProviderSdkCredentialStore({
			platformStore: {
				delete: async () => {
					throw new Error("fake platform store unavailable");
				},
				get: async () => {
					throw new Error("fake platform store unavailable");
				},
				set: async () => {
					throw new Error("fake platform store unavailable");
				},
			},
			userDataDir,
		});
		expect(await laterOutage.read("openrouter")).toBeUndefined();
		expect(await laterOutage.read("anthropic")).toBeUndefined();
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("concurrent credential refreshes cannot overwrite a newer stored value", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-provider-credential-rmw-")
	);
	const userDataDir = path.join(root, "user");
	const firstStore = createProviderSdkCredentialStore({
		platformStore: null,
		userDataDir,
	});
	const secondStore = createProviderSdkCredentialStore({
		platformStore: null,
		userDataDir,
	});
	try {
		await saveCredential(firstStore, "openai", {
			accessToken: "secret-access-token",
			kind: "oauth-session",
			refreshToken: "secret-refresh-token",
			revision: 0,
		});
		const incrementRevision = async (store: CredentialStore) =>
			store.modify("openai", async (credential) => {
				await Bun.sleep(5);
				if (typeof credential !== "object" || credential === null) {
					throw new Error("OAuth credential was not available.");
				}
				const record = credential as Record<string, unknown>;
				return {
					...record,
					revision: Number(record.revision) + 1,
				};
			});
		await Promise.all([
			incrementRevision(firstStore),
			incrementRevision(secondStore),
		]);
		expect(await firstStore.read("openai")).toMatchObject({ revision: 2 });
		const metadata = await firstStore.list();
		expect(metadata).toEqual([{ providerId: "openai", type: "oauth-session" }]);
		expect(JSON.stringify(metadata)).not.toContain("secret-");

		await expect(
			firstStore.modify("openai", () => {
				throw new Error("refresh rejected");
			})
		).rejects.toThrow("refresh rejected");
		expect(await firstStore.read("openai")).toMatchObject({ revision: 2 });
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("cancelled queued credential updates do not run after the active update", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-provider-credential-cancel-")
	);
	const store = createProviderSdkCredentialStore({
		platformStore: null,
		userDataDir: path.join(root, "user"),
	});
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const controller = new AbortController();
	let secondUpdateRan = false;
	try {
		const firstUpdate = store.modify("openai", async () => {
			started.resolve();
			await release.promise;
			return { kind: "oauth-session", revision: 1 };
		});
		await started.promise;
		const secondUpdate = store.modify(
			"openai",
			() => {
				secondUpdateRan = true;
				return { kind: "oauth-session", revision: 2 };
			},
			{ signal: controller.signal }
		);
		controller.abort(new DOMException("cancel before update", "AbortError"));
		await expect(secondUpdate).rejects.toThrow("cancel before update");
		release.resolve();
		await firstUpdate;
		expect(secondUpdateRan).toBe(false);
		expect(await store.read("openai")).toMatchObject({ revision: 1 });
	} finally {
		release.resolve();
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("a started credential update commits its replacement after caller cancellation", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-provider-store-update-abort-")
	);
	const store = createProviderSdkCredentialStore({
		platformStore: null,
		userDataDir: path.join(root, "user"),
	});
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const controller = new AbortController();
	try {
		await saveCredential(store, "openai", {
			kind: "oauth-session",
			revision: 1,
		});
		const update = store.modify(
			"openai",
			async () => {
				started.resolve();
				await release.promise;
				return { kind: "oauth-session", revision: 2 };
			},
			{ signal: controller.signal }
		);
		await started.promise;
		controller.abort(
			new DOMException("cancel before credential commit", "AbortError")
		);
		release.resolve();
		expect(await update).toMatchObject({ revision: 2 });
		expect(await store.read("openai")).toMatchObject({ revision: 2 });
	} finally {
		release.resolve();
		controller.abort();
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("aborting while the persistent transaction lock is held skips credential updates", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-provider-store-locked-abort-")
	);
	const userDataDir = path.join(root, "user");
	const store = createProviderSdkCredentialStore({
		platformStore: null,
		userDataDir,
	});
	const lockPath = path.join(
		userDataDir,
		"provider-sdk-credential-index.json.index.lock"
	);
	let updateRan = false;
	const controller = new AbortController();
	try {
		await saveCredential(store, "openai", {
			kind: "oauth-session",
			revision: 1,
		});
		await fs.writeFile(lockPath, "another process owns this lock", {
			mode: 0o600,
		});
		const update = store.modify(
			"openai",
			() => {
				updateRan = true;
				return { kind: "oauth-session", revision: 2 };
			},
			{ signal: controller.signal }
		);
		await Bun.sleep(30);
		controller.abort(new DOMException("cancel while locked", "AbortError"));
		await expect(update).rejects.toThrow("cancel while locked");
		expect(updateRan).toBe(false);
		await fs.rm(lockPath, { force: true });
		expect(await store.read("openai")).toMatchObject({ revision: 1 });
	} finally {
		controller.abort();
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("credential-index failures restore the last committed secret and fail closed", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-provider-store-index-recovery-")
	);
	const userDataDir = path.join(root, "user");
	const store = createProviderSdkCredentialStore({
		platformStore: null,
		userDataDir,
	});
	const previous = { apiKey: "last-committed-secret", kind: "api-key" };
	try {
		await saveCredential(store, "openrouter", previous);
		const indexPath = path.join(
			userDataDir,
			"provider-sdk-credential-index.json"
		);
		await fs.rm(indexPath);
		await fs.mkdir(indexPath);

		await expect(
			store.modify("openrouter", () => ({
				apiKey: "uncommitted-secret",
				kind: "api-key",
			}))
		).rejects.toThrow("could not be recovered");
		expect(await store.read("openrouter")).toEqual(previous);
		await expect(store.list()).rejects.toThrow("Provider SDK credential index");
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("Provider credential deletion can retry on the same store after platform failure", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-provider-credential-delete-failure-")
	);
	const userDataDir = path.join(root, "user");
	const credential = { apiKey: "fake-delete-key", kind: "api-key" } as const;
	const fallback = createProviderSdkCredentialStore({
		platformStore: null,
		userDataDir,
	});
	let deleteAttempts = 0;
	const platformValues = new Map<string, string>();
	try {
		await saveCredential(fallback, "openrouter", credential);
		const recoveringPlatform = createProviderSdkCredentialStore({
			platformStore: {
				delete: async ({ name, service }) => {
					deleteAttempts++;
					if (deleteAttempts === 1) {
						throw new Error("simulated platform delete failure");
					}
					platformValues.delete(`${service}:${name}`);
					return true;
				},
				get: async ({ name, service }) =>
					platformValues.get(`${service}:${name}`) ?? null,
				set: async ({ name, service, value }) => {
					platformValues.set(`${service}:${name}`, value);
				},
			},
			userDataDir,
		});
		await expect(recoveringPlatform.delete("openrouter")).rejects.toThrow(
			"Could not delete Provider SDK credential from the platform secret store."
		);
		expect(await recoveringPlatform.read("openrouter")).toEqual(credential);

		await recoveringPlatform.delete("openrouter");
		expect(deleteAttempts).toBe(2);
		const laterOutage = createProviderSdkCredentialStore({
			platformStore: {
				delete: async () => {
					throw new Error("fake platform store unavailable");
				},
				get: async () => {
					throw new Error("fake platform store unavailable");
				},
				set: async () => {
					throw new Error("fake platform store unavailable");
				},
			},
			userDataDir,
		});
		expect(await laterOutage.read("openrouter")).toBeUndefined();
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});
