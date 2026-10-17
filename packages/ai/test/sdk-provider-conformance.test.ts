import { expect, test } from "bun:test";
import {
	type ChatEvent,
	type ChatRequest,
	createAnthropicProvider,
	createDeepSeekProvider,
	createGoogleProvider,
	createOpenAIProvider,
	createOpenCodeGoProvider,
	createOpenRouterProvider,
	createProviderCollection,
	type Provider,
	type ProviderCollection,
	type ProviderModel,
} from "@wincode/ai";

type ProviderFetch = (
	input: string | URL | Request,
	init?: RequestInit
) => Promise<Response>;
type ProviderFactoryCase = Readonly<{
	create: (fetch: ProviderFetch) => Provider;
	discoverable: boolean;
	expectedModelIds: readonly string[];
	providerId: string;
}>;
type FakeTransport = Readonly<{
	fetch: ProviderFetch;
	requestCount: () => number;
}>;

const providerFactories: readonly ProviderFactoryCase[] = [
	{
		create: (fetch) => createAnthropicProvider({ fetch }),
		discoverable: false,
		expectedModelIds: ["claude-opus-5.5"],
		providerId: "anthropic",
	},
	{
		create: (fetch) => createDeepSeekProvider({ fetch }),
		discoverable: false,
		expectedModelIds: ["deepseek-chat", "deepseek-reasoner"],
		providerId: "deepseek",
	},
	{
		create: (fetch) => createGoogleProvider({ fetch }),
		discoverable: false,
		expectedModelIds: ["gemini-3.6-flash"],
		providerId: "google",
	},
	{
		create: (fetch) => createOpenAIProvider({ fetch }),
		discoverable: false,
		expectedModelIds: ["gpt-5.6"],
		providerId: "openai",
	},
	{
		create: (fetch) => createOpenCodeGoProvider({ fetch }),
		discoverable: false,
		expectedModelIds: ["grok-4.6", "gpt-5.6-luna", "minimax-m3"],
		providerId: "opencode-go",
	},
	{
		create: (fetch) => createOpenRouterProvider({ fetch }),
		discoverable: true,
		expectedModelIds: [],
		providerId: "openrouter",
	},
];

const createFakeTransport = (respond?: ProviderFetch): FakeTransport => {
	let requestCount = 0;
	return Object.freeze({
		fetch: async (input, init) => {
			requestCount++;
			if (respond === undefined) {
				throw new Error("Unexpected provider transport request.");
			}
			return respond(input, init);
		},
		requestCount: () => requestCount,
	});
};

const modelIdentitiesFor = (
	models: readonly ProviderModel[]
): readonly Pick<ProviderModel, "modelId" | "providerId">[] =>
	models.map(({ modelId, providerId }) => ({ modelId, providerId }));

const collectChatEvents = async (
	collection: ProviderCollection,
	request: ChatRequest
): Promise<readonly ChatEvent[]> => {
	const events: ChatEvent[] = [];
	for await (const event of collection.chat(request)) {
		events.push(event);
	}
	return events;
};

const expectAuthenticationFailure = (
	events: readonly ChatEvent[],
	providerId: string
): void => {
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		outcome: {
			failure: { code: "authentication", providerId },
			status: "failure",
		},
		type: "terminal",
	});
};

const withProviderCollection = async <Result>(
	provider: Provider,
	work: (collection: ProviderCollection) => Promise<Result>
): Promise<Result> => {
	const collection = createProviderCollection();
	let registered = false;
	try {
		collection.register(provider);
		registered = true;
		return await work(collection);
	} finally {
		if (registered) {
			await collection.close();
		} else {
			await provider.close?.();
		}
	}
};

for (const factoryCase of providerFactories) {
	test(`${factoryCase.providerId} factory publishes its exact model identities offline`, async () => {
		const transport = createFakeTransport();
		const provider = factoryCase.create(transport.fetch);

		await withProviderCollection(provider, async (collection) => {
			expect(provider.id).toBe(factoryCase.providerId);
			expect(provider.discoverModels !== undefined).toBe(
				factoryCase.discoverable
			);
			expect(modelIdentitiesFor(collection.getModels())).toEqual(
				modelIdentitiesFor(provider.models)
			);
			for (const modelId of factoryCase.expectedModelIds) {
				const model = collection.getModel(factoryCase.providerId, modelId);
				expect(model).toBeDefined();
				expect(model?.providerId).toBe(factoryCase.providerId);
				expect(model?.modelId).toBe(modelId);
			}
		});

		expect(transport.requestCount()).toBe(0);
	});

	test(`${factoryCase.providerId} factory rejects an unlisted model before transport`, async () => {
		const transport = createFakeTransport();
		const provider = factoryCase.create(transport.fetch);
		const unlistedModelId = "not-published-for-conformance";

		await withProviderCollection(provider, async (collection) => {
			const events = await collectChatEvents(collection, {
				messages: [],
				modelId: unlistedModelId,
				providerId: factoryCase.providerId,
			});
			expect(events).toEqual([
				{
					outcome: {
						failure: {
							code: "model-not-found",
							modelId: unlistedModelId,
							providerId: factoryCase.providerId,
						},
						status: "failure",
					},
					type: "terminal",
				},
			]);
		});

		expect(transport.requestCount()).toBe(0);
	});

	const knownModelId = factoryCase.expectedModelIds[0];
	if (knownModelId !== undefined) {
		test(`${factoryCase.providerId} requires credentials for a published model before transport`, async () => {
			const transport = createFakeTransport();
			const provider = factoryCase.create(transport.fetch);

			await withProviderCollection(provider, async (collection) => {
				expect(await collection.getAvailable()).toEqual([]);
				const events = await collectChatEvents(collection, {
					messages: [],
					modelId: knownModelId,
					providerId: factoryCase.providerId,
				});
				expectAuthenticationFailure(events, factoryCase.providerId);
			});

			expect(transport.requestCount()).toBe(0);
		});
	}
}

const openRouterModelId = "vendor/exact-conformance-model";
const createOpenRouterDiscoveryTransport = (): FakeTransport =>
	createFakeTransport(async (input) => {
		if (String(input).endsWith("/models")) {
			return Response.json({ data: [{ id: openRouterModelId }] });
		}
		throw new Error("Unexpected OpenRouter chat transport request.");
	});

const discoverOpenRouterModel = async (
	collection: ProviderCollection
): Promise<readonly ProviderModel[]> => {
	await collection.setCredential("openrouter", {
		apiKey: "fake-openrouter-key",
		kind: "api-key",
	});
	const refresh = await collection.refreshModels({
		providerIds: ["openrouter"],
	});
	if (refresh.aborted || refresh.errors.size > 0) {
		throw new Error("OpenRouter model discovery failed.");
	}
	return collection
		.getModels()
		.filter(({ providerId }) => providerId === "openrouter");
};

test("OpenRouter discovery publishes the exact discovered model identity", async () => {
	const transport = createOpenRouterDiscoveryTransport();
	const provider = createOpenRouterProvider({ fetch: transport.fetch });

	await withProviderCollection(provider, async (collection) => {
		const discovered = await discoverOpenRouterModel(collection);
		expect(modelIdentitiesFor(discovered)).toEqual([
			{ modelId: openRouterModelId, providerId: "openrouter" },
		]);
		expect(collection.getModel("openrouter", openRouterModelId)).toMatchObject({
			modelId: openRouterModelId,
			protocolId: "openai-compatible",
			providerId: "openrouter",
		});
	});

	expect(transport.requestCount()).toBe(1);
});

test("OpenRouter requires credentials to chat with a discovered model", async () => {
	const transport = createOpenRouterDiscoveryTransport();
	const provider = createOpenRouterProvider({ fetch: transport.fetch });

	await withProviderCollection(provider, async (collection) => {
		await discoverOpenRouterModel(collection);
		await collection.deleteCredential("openrouter");

		const events = await collectChatEvents(collection, {
			messages: [],
			modelId: openRouterModelId,
			providerId: "openrouter",
		});
		expectAuthenticationFailure(events, "openrouter");
	});

	expect(transport.requestCount()).toBe(1);
});

test("DeepSeek enforces declared model capabilities before provider transport", async () => {
	const transport = createFakeTransport();
	const provider = createDeepSeekProvider({ fetch: transport.fetch });

	await withProviderCollection(provider, async (collection) => {
		await collection.setCredential("deepseek", {
			apiKey: "fake-deepseek-key",
			kind: "api-key",
		});
		const events = await collectChatEvents(collection, {
			messages: [
				{
					content: [
						{
							data: "fake-image-bytes",
							mediaType: "image/png",
							type: "image",
						},
					],
					role: "user",
				},
			],
			modelId: "deepseek-chat",
			providerId: "deepseek",
		});
		expect(events).toEqual([
			{
				outcome: {
					failure: {
						capability: "image",
						code: "unsupported-capability",
						modelId: "deepseek-chat",
						providerId: "deepseek",
					},
					status: "failure",
				},
				type: "terminal",
			},
		]);
	});

	expect(transport.requestCount()).toBe(0);
});

const openAIOAuthCredential = {
	accessToken: "fake-oauth-access-token",
	accountId: "fake-account",
	expiresAt: "2030-01-01T00:00:00.000Z",
	kind: "oauth-session",
	refreshToken: "fake-oauth-refresh-token",
	updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

test("OpenAI does not enforce output-token limits with OAuth credentials", async () => {
	const transport = createFakeTransport();
	const provider = createOpenAIProvider({ fetch: transport.fetch });

	await withProviderCollection(provider, async (collection) => {
		await collection.setCredential("openai", openAIOAuthCredential);
		expect(
			await collection.canEnforceMaxOutputTokens("openai", "gpt-5.6")
		).toBe(false);
	});

	expect(transport.requestCount()).toBe(0);
});

test("OpenAI enforces output-token limits with API-key credentials", async () => {
	const transport = createFakeTransport();
	const provider = createOpenAIProvider({ fetch: transport.fetch });

	await withProviderCollection(provider, async (collection) => {
		await collection.setCredential("openai", {
			apiKey: "fake-openai-api-key",
			kind: "api-key",
		});
		expect(
			await collection.canEnforceMaxOutputTokens("openai", "gpt-5.6")
		).toBe(true);
	});

	expect(transport.requestCount()).toBe(0);
});
