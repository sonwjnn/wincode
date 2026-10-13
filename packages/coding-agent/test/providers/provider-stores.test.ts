import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ProviderModel } from "@wincode/ai/sdk";
import {
	createProviderSdkCredentialStore,
	createProviderSdkModelStore,
} from "@/modules/providers/provider-stores";

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
