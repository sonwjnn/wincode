import { expect, test } from "bun:test";
import {
	type CredentialStore,
	createProviderCollection,
	type ModelStore,
	type Provider,
	type ProviderModel,
} from "@wincode/ai";
import type { PluginProviderDescriptor } from "@/modules/plugins/runtime";
import { createInteractiveProviderController } from "@/modules/providers/interactive-provider-controller";
import { createInteractiveSessionProviderCollection } from "@/modules/sessions/provider-collection";

test("manual Provider Model refresh notifies availability subscribers only when the model list changes", async () => {
	const providerId = "fixture-refresh";
	const makeModel = (modelId: string): ProviderModel => ({
		modelId,
		protocolId: "fixture",
		providerId,
	});
	let discoveredModels = [makeModel("first-model")];
	const collection = createProviderCollection({
		credentialStore: {
			delete: () => undefined,
			get: (storedProviderId) =>
				storedProviderId === providerId ? "fixture-key" : undefined,
			set: () => undefined,
		},
	});
	collection.register({
		discoverModels: () => discoveredModels,
		id: providerId,
		models: [],
		resolveAuthorization: () => ({ authorization: {} }),
		async *streamChat() {
			yield { type: "finish" };
		},
	});
	const controller = createInteractiveProviderController(collection);
	let notifications = 0;
	const unsubscribe = controller.subscribeAvailability?.(() => {
		notifications += 1;
	});

	try {
		await controller.refreshProviderModels(providerId);
		expect(notifications).toBe(1);
		await controller.refreshProviderModels(providerId);
		expect(notifications).toBe(1);

		discoveredModels = [makeModel("second-model")];
		await controller.refreshProviderModels(providerId);
		expect(notifications).toBe(2);
		expect(await controller.getAvailableModels()).toHaveLength(1);
		expect(await controller.getKnownModels()).toContainEqual(
			makeModel("second-model")
		);
	} finally {
		unsubscribe?.();
		await collection.close();
	}
});

test("known Provider Model availability scopes credentials while global chooser discovery remains unscoped", async () => {
	const credentialReads: string[] = [];
	const selectedModel: ProviderModel = {
		modelId: "selected-model",
		protocolId: "fixture",
		providerId: "openai",
	};
	const unrelatedModel: ProviderModel = {
		modelId: "unrelated-model",
		protocolId: "fixture",
		providerId: "anthropic",
	};
	const collection = createProviderCollection({
		credentialStore: {
			delete: () => undefined,
			get: (providerId) => {
				credentialReads.push(providerId);
				return "fake-provider-key";
			},
			set: () => undefined,
		},
	});
	for (const model of [selectedModel, unrelatedModel]) {
		collection.register({
			id: model.providerId,
			models: [model],
			resolveAuthorization: () => ({ authorization: "fake" }),
			async *streamChat() {
				yield { type: "finish" };
			},
		});
	}
	const controller = createInteractiveProviderController(collection, {
		withSessionWork: async (action) => await action(),
	});
	try {
		expect(await controller.getAvailableModels("openai")).toEqual([
			selectedModel,
		]);
		expect(credentialReads).toEqual(["openai"]);
		credentialReads.length = 0;
		expect(await controller.getAvailableModels()).toEqual([
			selectedModel,
			unrelatedModel,
		]);
		expect(credentialReads).toEqual(["openai", "anthropic"]);
		credentialReads.length = 0;
		expect(
			(
				await controller.getAvailableProviderModelSelectionCandidates?.(
					"openai"
				)
			)?.map(({ model }) => model)
		).toEqual([selectedModel]);
		expect(credentialReads).toEqual(["openai"]);
		credentialReads.length = 0;
		expect(
			(await controller.getAvailableProviderModelSelectionCandidates?.())?.map(
				({ model }) => model
			)
		).toEqual([selectedModel, unrelatedModel]);
		expect(credentialReads).toEqual(["openai", "anthropic"]);
	} finally {
		await collection.close();
	}
});

test("OAuth methods are omitted when their provider-specific login is unavailable", async () => {
	const collection = createProviderCollection({
		credentialStore: {
			delete: () => undefined,
			get: () => undefined,
			set: () => undefined,
		},
	});
	const controller = createInteractiveProviderController(collection);

	try {
		expect(
			controller.getConnectableProviders().some(({ kind }) => kind === "oauth")
		).toBe(false);
	} finally {
		await collection.close();
	}
});

test("built-in API-key connection stores the secret without live validation or Plugin handoff", async () => {
	const credentials = new Map<string, unknown>();
	const credentialReadProviderIds: string[] = [];
	let failCredentialWrites = false;
	const credentialStore: CredentialStore = {
		delete: (providerId) => {
			credentials.delete(providerId);
		},
		get: (providerId) => {
			credentialReadProviderIds.push(providerId);
			return credentials.get(providerId);
		},
		set: (providerId, credential) => {
			if (failCredentialWrites) {
				const apiKey =
					typeof credential === "object" &&
					credential !== null &&
					"apiKey" in credential
						? String(credential.apiKey)
						: "unknown";
				throw new Error(`Fake secure storage rejected ${apiKey}.`);
			}
			credentials.set(providerId, credential);
		},
	};
	const modelStore: ModelStore = {
		get: () => undefined,
		set: () => undefined,
	};
	const pluginModel: ProviderModel = {
		modelId: "fixture",
		protocolId: "fixture",
		providerId: "fixture-plugin",
	};
	let pluginConnectCalls = 0;
	const pluginProvider: Provider = {
		id: pluginModel.providerId,
		models: [pluginModel],
		resolveAuthorization: () => ({ authorization: {} }),
		async *streamChat() {
			yield { type: "finish" };
		},
	};
	const pluginRegistration: PluginProviderDescriptor = {
		connect: async () => {
			pluginConnectCalls += 1;
			return;
		},
		createProvider: () => pluginProvider,
		displayName: "Fixture Plugin",
		pluginId: "fixture-plugin-owner",
		providerId: pluginModel.providerId,
		sourceIdentity: "fixture-plugin-source",
		sourcePath: "fixture-plugin-source",
	};
	let networkRequests = 0;
	const fakeOAuthCredential = {
		accessToken: "fake-oauth-access-token",
		accountId: "fake-openai-account",
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		kind: "oauth-session" as const,
		refreshToken: "fake-oauth-refresh-token",
		updatedAt: new Date().toISOString(),
	};
	let loginOptions: { openBrowser?: boolean; signal?: AbortSignal } | undefined;
	const collection = await createInteractiveSessionProviderCollection({
		credentialStore,
		googleProviderOptions: {
			fetch: async () => {
				networkRequests += 1;
				return Response.json({ models: [] });
			},
		},
		modelStore,
		openAIProviderOptions: {
			login: async (options) => {
				loginOptions = options;
				return fakeOAuthCredential;
			},
		},
		pluginProviders: [pluginRegistration],
	});
	const controller = createInteractiveProviderController(collection, {
		getDiscoverableProviderIds: collection.getDiscoverableProviderIds,
		getPluginProviderRegistrations: collection.getPluginProviderRegistrations,
		getPluginProviderComposition: collection.getPluginProviderComposition,
		supportsModelDiscovery: collection.supportsModelDiscovery,
		loginOpenAIOAuth: collection.loginOpenAIOAuth,
	});
	let availabilityNotifications = 0;
	const unsubscribe = controller.subscribeAvailability?.(() => {
		availabilityNotifications += 1;
	});

	try {
		const connectable = controller.getConnectableProviders();
		expect(
			connectable
				.filter(({ kind }) => kind === "api-key")
				.map(({ displayName, providerId }) => ({ displayName, providerId }))
		).toEqual([
			{ displayName: "OpenAI Provider SDK", providerId: "openai" },
			{ displayName: "Anthropic Provider SDK", providerId: "anthropic" },
			{ displayName: "Google Provider SDK", providerId: "google" },
			{ displayName: "OpenCode Go Provider SDK", providerId: "opencode-go" },
			{ displayName: "DeepSeek Provider SDK", providerId: "deepseek" },
		]);
		expect(connectable).toContainEqual(
			expect.objectContaining({
				displayName: "OpenRouter Provider SDK",
				kind: "api-key-with-model-discovery",
				methodId: "openrouter-api-key",
				providerId: "openrouter",
			})
		);
		expect(
			connectable.some(({ providerId }) => providerId === "fixture-plugin")
		).toBe(true);
		expect(connectable).toContainEqual(
			expect.objectContaining({
				displayName: "OpenAI browser sign-in",
				kind: "oauth",
				methodId: "openai-browser",
				providerId: "openai",
			})
		);
		const oauthOption = connectable.find(({ kind }) => kind === "oauth");
		if (oauthOption?.kind !== "oauth") {
			throw new Error("The OpenAI OAuth connection method was unavailable.");
		}
		const oauthSignal = new AbortController().signal;
		const oauthModels = await oauthOption.connectOAuth({
			onStatus: () => undefined,
			signal: oauthSignal,
		});
		expect(loginOptions).toMatchObject({
			onStatus: expect.any(Function),
			signal: oauthSignal,
		});
		expect(credentials.get("openai")).toEqual(fakeOAuthCredential);
		expect(oauthModels.some(({ providerId }) => providerId === "openai")).toBe(
			true
		);
		expect(credentialReadProviderIds).toEqual(["openai"]);
		expect(availabilityNotifications).toBe(1);

		const googleApiKeyOption = connectable.find(
			(option) => option.kind === "api-key" && option.providerId === "google"
		);
		if (googleApiKeyOption?.kind !== "api-key") {
			throw new Error("The Google API-key connection method was unavailable.");
		}
		const models = await googleApiKeyOption.connectApiKey(
			"  fake-google-key  "
		);
		expect(credentials.get("google")).toEqual({
			apiKey: "fake-google-key",
			kind: "api-key",
		});
		expect(models.some(({ providerId }) => providerId === "google")).toBe(true);
		expect(await controller.getAvailableModels()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					modelId: "gemini-3.8-flash",
					providerId: "google",
				}),
			])
		);
		expect(networkRequests).toBe(0);
		expect(availabilityNotifications).toBe(2);

		const privateKey = "must-not-appear-in-errors";
		failCredentialWrites = true;
		const saveFailure = await controller
			.connectProviderApiKey("google", privateKey)
			.catch((failure: unknown) => failure);
		expect(saveFailure).toBeInstanceOf(Error);
		if (!(saveFailure instanceof Error)) {
			throw new Error("The fake credential store should reject the write.");
		}
		expect(saveFailure.message).toBe(
			"Could not save Provider SDK credentials."
		);
		expect(saveFailure.message).not.toContain(privateKey);
		expect(networkRequests).toBe(0);

		await expect(
			controller.connectProviderApiKey("fixture-plugin", "plugin-secret")
		).rejects.toThrow("Provider SDK API-key connection is unavailable.");
		expect(pluginConnectCalls).toBe(0);
	} finally {
		unsubscribe?.();
		await collection.close();
	}
});
