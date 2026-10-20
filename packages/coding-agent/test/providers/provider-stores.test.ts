import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ProviderModel } from "@wincode/ai";
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
		await credentialsOne.set("openrouter", {
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
		expect(await restartedCredentials.get("openrouter")).toEqual({
			apiKey: "fake-user-one-key",
			kind: "api-key",
		});
		expect(await restartedModels.get("openrouter")).toEqual(savedModels);
		expect(await credentialsTwo.get("openrouter")).toBeUndefined();
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
		await duringOutage.set("openrouter", credential);

		const afterRestart = createProviderSdkCredentialStore({
			platformStore: {
				delete: async () => false,
				get: async () => null,
				set: async () => undefined,
			},
			userDataDir,
		});
		expect(await afterRestart.get("openrouter")).toEqual(credential);
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
		await fallback.set("openrouter", staleCredential);
		await fallback.set("anthropic", staleCredential);

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
		await recovered.set("openrouter", replacementCredential);
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
		expect(await laterOutage.get("openrouter")).toBeUndefined();
		expect(await laterOutage.get("anthropic")).toBeUndefined();
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
	try {
		await fallback.set("openrouter", credential);
		const recoveringPlatform = createProviderSdkCredentialStore({
			platformStore: {
				delete: async () => {
					deleteAttempts++;
					if (deleteAttempts === 1) {
						throw new Error("simulated platform delete failure");
					}
					return true;
				},
				get: async () => null,
				set: async () => undefined,
			},
			userDataDir,
		});
		await expect(recoveringPlatform.delete("openrouter")).rejects.toThrow(
			"Could not delete Provider SDK credential from the platform secret store."
		);
		expect(await fallback.get("openrouter")).toEqual(credential);

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
		expect(await laterOutage.get("openrouter")).toBeUndefined();
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});
