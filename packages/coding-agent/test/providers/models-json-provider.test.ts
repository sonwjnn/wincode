import { expect, test } from "bun:test";
import type { ChatEvent, ModelStore, ProviderCollection } from "@wincode/ai";
import { loadUserModelsJsonProviders } from "@/modules/providers/models-json";
import { createSessionCapabilities } from "@/modules/sessions/host/session-capabilities";
import { createDefaultSessionProviderCollection } from "@/modules/sessions/provider-collection";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createConfigStore } from "@/shared/config/config-store";
import { createEmptyPluginRuntime } from "../support/plugin-runtime";
import { createInMemoryCredentialStore } from "../support/provider-stores";

const HOME_ROOT = "/home/configured-user";
const WORKSPACE = "/workspace/configured-models";
const USER_MODELS_PATH = `${HOME_ROOT}/.wincode/models.json`;
const PROJECT_MODELS_PATH = `${WORKSPACE}/.wincode/models.json`;

const createConfigStoreWithFiles = (files: Record<string, string>) =>
	createConfigStore({
		fs: {
			readFile: async (file) => {
				const contents = files[file];
				if (contents === undefined) {
					throw Object.assign(new Error("missing"), { code: "ENOENT" });
				}
				return contents;
			},
		},
		homeRoot: HOME_ROOT,
		trustedProjectRoots: [WORKSPACE],
	});

const modelStore: ModelStore = {
	get: () => undefined,
	set: () => undefined,
};

const compatibleStream = () =>
	new Response(
		[
			'data: {"choices":[{"delta":{"content":"Configured response"}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
			"data: [DONE]\n\n",
		].join(""),
		{ headers: { "content-type": "text/event-stream" } }
	);

const sseResponse = (events: readonly Readonly<Record<string, unknown>>[]) =>
	new Response(
		`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
		{ headers: { "content-type": "text/event-stream" } }
	);

const fakeFetch = (
	implementation: (
		input: string | URL | Request,
		init?: RequestInit
	) => Promise<Response>
): typeof globalThis.fetch =>
	Object.assign(implementation, { preconnect: () => undefined });

test("user models.json models retain exact identity and use only the global API key source for chat", async () => {
	const files: Record<string, string> = {
		[USER_MODELS_PATH]: JSON.stringify({
			providers: {
				"custom-compatible": {
					api: "openai-completions",
					apiKey: "$MODELS_API_KEY",
					baseUrl: "https://configured.example/v1",
					models: [
						{
							contextWindow: 32_000,
							id: "vendor/model-with-slash",
							input: ["text"],
							maxTokens: 4000,
							name: "Vendor Model",
						},
					],
				},
			},
		}),
		[PROJECT_MODELS_PATH]: JSON.stringify({
			providers: {
				"project-only": {
					api: "openai-completions",
					apiKey: "project-secret",
					baseUrl: "https://project.example/v1",
					models: [{ id: "project-model" }],
				},
			},
		}),
	};
	const requests: Array<{
		body: Record<string, unknown>;
		headers: Headers;
		url: string;
	}> = [];
	const credentials = new Map<string, unknown>();
	const configuredProviders = await loadUserModelsJsonProviders(
		createConfigStoreWithFiles(files),
		WORKSPACE,
		{
			environment: { MODELS_API_KEY: "environment-key" },
			fetch: fakeFetch(async (input, init) => {
				requests.push({
					body: JSON.parse(String(init?.body)) as Record<string, unknown>,
					headers: new Headers(init?.headers),
					url: String(input),
				});
				return compatibleStream();
			}),
		}
	);
	const collection = await createDefaultSessionProviderCollection(
		undefined,
		"models-json-session",
		{
			configuredModelProviders: configuredProviders,
			credentialStore: createInMemoryCredentialStore(credentials),
			modelStore,
		}
	);

	try {
		expect(collection.getModels()).toContainEqual({
			capabilities: ["text"],
			limits: { contextWindowTokens: 32_000, maxOutputTokens: 4000 },
			modelId: "vendor/model-with-slash",
			name: "Vendor Model",
			protocolId: "openai-compatible",
			providerId: "custom-compatible",
		});
		expect(
			collection
				.getModels()
				.some(({ providerId }) => providerId === "project-only")
		).toBe(false);
		expect(
			(await collection.getAvailable("custom-compatible")).some(
				({ modelId }) => modelId === "vendor/model-with-slash"
			)
		).toBe(true);
		expect(await collection.checkAuth("custom-compatible")).toMatchObject({
			status: "configured",
		});

		const events: ChatEvent[] = [];
		for await (const event of collection.chat({
			messages: [
				{ content: [{ text: "Say hello", type: "text" }], role: "user" },
			],
			modelId: "vendor/model-with-slash",
			providerId: "custom-compatible",
		})) {
			events.push(event);
		}

		expect(events.at(-1)).toMatchObject({
			outcome: { status: "success" },
			type: "terminal",
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(
			"https://configured.example/v1/chat/completions"
		);
		expect(requests[0]?.body.model).toBe("vendor/model-with-slash");
		expect(requests[0]?.headers.get("authorization")).toBe(
			"Bearer environment-key"
		);
		expect(credentials.size).toBe(0);
	} finally {
		await collection.close();
	}
});

test("models.json rejects Provider IDs that cannot round-trip through persisted selections", async () => {
	const configuredProviders = await loadUserModelsJsonProviders(
		createConfigStoreWithFiles({
			[USER_MODELS_PATH]: JSON.stringify({
				providers: {
					"vendor/gateway": {
						api: "openai-completions",
						baseUrl: "https://configured.example/v1",
						models: [{ id: "model" }],
					},
				},
			}),
		}),
		WORKSPACE
	);

	expect(configuredProviders).toEqual([]);
});

test("models.json skips whitespace-only model identities instead of aborting collection registration", async () => {
	const configuredProviders = await loadUserModelsJsonProviders(
		createConfigStoreWithFiles({
			[USER_MODELS_PATH]: JSON.stringify({
				providers: {
					"blank-model-id": {
						api: "openai-completions",
						baseUrl: "https://blank-id.example/v1",
						models: [{ id: "   " }],
					},
					"blank-model-name": {
						api: "openai-completions",
						baseUrl: "https://blank-name.example/v1",
						models: [{ id: "usable-model", name: " \t " }],
					},
					"blank-provider-name": {
						api: "openai-completions",
						baseUrl: "https://blank-provider-name.example/v1",
						models: [{ id: "usable-model" }],
						name: " \n",
					},
					"valid-provider": {
						api: "openai-completions",
						baseUrl: "https://valid.example/v1",
						models: [{ id: "valid-model" }],
					},
				},
			}),
		}),
		WORKSPACE
	);
	const collection = await createDefaultSessionProviderCollection(
		undefined,
		"invalid-model-identities-session",
		{
			configuredModelProviders: configuredProviders,
			credentialStore: createInMemoryCredentialStore(new Map()),
			modelStore,
		}
	);

	try {
		expect(
			collection
				.getModels()
				.filter(({ providerId }) => providerId === "valid-provider")
				.map(({ modelId }) => modelId)
		).toEqual(["valid-model"]);
	} finally {
		await collection.close();
	}
});

test("command API-key sources are cached for the provider lifetime and never persisted as credentials", async () => {
	const files = {
		[USER_MODELS_PATH]: JSON.stringify({
			providers: {
				"command-provider": {
					api: "openai-completions",
					apiKey: "!read-secret-command",
					baseUrl: "https://command.example/v1",
					models: [{ id: "command-model" }],
				},
			},
		}),
	};
	let commandRuns = 0;
	const credentials = new Map<string, unknown>();
	const configuredProviders = await loadUserModelsJsonProviders(
		createConfigStoreWithFiles(files),
		WORKSPACE,
		{
			commandRunner: async (command) => {
				expect(command).toBe("read-secret-command");
				commandRuns += 1;
				return "command-key\n";
			},
			fetch: fakeFetch(async () => compatibleStream()),
		}
	);
	const collection = await createDefaultSessionProviderCollection(
		undefined,
		"command-model-session",
		{
			configuredModelProviders: configuredProviders,
			credentialStore: createInMemoryCredentialStore(credentials),
			modelStore,
		}
	);

	try {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			for await (const _event of collection.chat({
				messages: [
					{ content: [{ text: "Say hello", type: "text" }], role: "user" },
				],
				modelId: "command-model",
				providerId: "command-provider",
			})) {
				// Consuming terminal events proves each request reached the adapter.
			}
		}
		expect(commandRuns).toBe(1);
		expect(credentials.size).toBe(0);
	} finally {
		await collection.close();
	}
});

test("command API-key failures surface as authentication failures without dispatching", async () => {
	const files = {
		[USER_MODELS_PATH]: JSON.stringify({
			providers: {
				"command-failure-provider": {
					api: "openai-completions",
					apiKey: "!fail-command",
					baseUrl: "https://command-failure.example/v1",
					models: [{ id: "command-failure-model" }],
				},
			},
		}),
	};
	let requestCount = 0;
	const configuredProviders = await loadUserModelsJsonProviders(
		createConfigStoreWithFiles(files),
		WORKSPACE,
		{
			commandRunner: async () => {
				throw new Error("command execution failed");
			},
			fetch: fakeFetch(async () => {
				requestCount += 1;
				return compatibleStream();
			}),
		}
	);
	const collection = await createDefaultSessionProviderCollection(
		undefined,
		"command-failure-session",
		{
			configuredModelProviders: configuredProviders,
			credentialStore: createInMemoryCredentialStore(new Map()),
			modelStore,
		}
	);

	try {
		const events: ChatEvent[] = [];
		for await (const event of collection.chat({
			messages: [
				{ content: [{ text: "Say hello", type: "text" }], role: "user" },
			],
			modelId: "command-failure-model",
			providerId: "command-failure-provider",
		})) {
			events.push(event);
		}
		expect(events.at(-1)).toMatchObject({
			outcome: {
				failure: {
					code: "authentication",
					providerId: "command-failure-provider",
				},
				status: "failure",
			},
			type: "terminal",
		});
		expect(requestCount).toBe(0);
	} finally {
		await collection.close();
	}
});

test("command API-key output is not shared across providers with different environments", async () => {
	const files = {
		[USER_MODELS_PATH]: JSON.stringify({
			providers: {
				"first-command-provider": {
					api: "openai-completions",
					apiKey: "!same-command",
					baseUrl: "https://first.example/v1",
					models: [{ id: "first-command-model" }],
				},
				"second-command-provider": {
					api: "openai-completions",
					apiKey: "!same-command",
					baseUrl: "https://second.example/v1",
					models: [{ id: "second-command-model" }],
				},
			},
		}),
	};
	let commandRuns = 0;
	const requests: Headers[] = [];
	const commandRunner = async (
		command: string,
		environment: Readonly<Record<string, string | undefined>>
	) => {
		expect(command).toBe("same-command");
		commandRuns += 1;
		return environment.API_KEY ?? "";
	};
	const configStore = createConfigStoreWithFiles(files);
	const fetch = fakeFetch(async (_input, init) => {
		requests.push(new Headers(init?.headers));
		return compatibleStream();
	});
	const firstProvider = (
		await loadUserModelsJsonProviders(configStore, WORKSPACE, {
			commandRunner,
			environment: { API_KEY: "first-key" },
			fetch,
		})
	).find(({ provider }) => provider.id === "first-command-provider");
	const secondProvider = (
		await loadUserModelsJsonProviders(configStore, WORKSPACE, {
			commandRunner,
			environment: { API_KEY: "second-key" },
			fetch,
		})
	).find(({ provider }) => provider.id === "second-command-provider");
	if (firstProvider === undefined || secondProvider === undefined) {
		throw new Error("Configured command providers were not loaded.");
	}
	const credentials = new Map<string, unknown>();
	const collection = await createDefaultSessionProviderCollection(
		undefined,
		"command-environment-session",
		{
			configuredModelProviders: [firstProvider, secondProvider],
			credentialStore: createInMemoryCredentialStore(credentials),
			modelStore,
		}
	);

	try {
		for (const { modelId, providerId } of [
			{
				modelId: "first-command-model",
				providerId: "first-command-provider",
			},
			{
				modelId: "second-command-model",
				providerId: "second-command-provider",
			},
		]) {
			for await (const _event of collection.chat({
				messages: [
					{ content: [{ text: "Say hello", type: "text" }], role: "user" },
				],
				modelId,
				providerId,
			})) {
				// Request completion proves the configured key reached the adapter.
			}
		}
		expect(commandRuns).toBe(2);
		expect(requests.map((headers) => headers.get("authorization"))).toEqual([
			"Bearer first-key",
			"Bearer second-key",
		]);
		expect(credentials.size).toBe(0);
	} finally {
		await collection.close();
	}
});

test("session provider composition loads user models.json and ignores project providers", async () => {
	const files = {
		[USER_MODELS_PATH]: JSON.stringify({
			providers: {
				"session-user-provider": {
					api: "openai-completions",
					apiKey: "user-key",
					baseUrl: "https://user.example/v1",
					models: [{ id: "user-model" }],
				},
			},
		}),
		[PROJECT_MODELS_PATH]: JSON.stringify({
			providers: {
				"session-project-provider": {
					api: "openai-completions",
					apiKey: "project-key",
					baseUrl: "https://project.example/v1",
					models: [{ id: "project-model" }],
				},
			},
		}),
	};
	const configStore = createConfigStoreWithFiles(files);
	const credentials = new Map<string, unknown>();
	const database = createDatabase(":memory:");
	const pluginRuntime = createEmptyPluginRuntime();
	const assembly = await createSessionCapabilities({
		createProviderCollection: (
			runtime,
			sessionId,
			allowedPluginProviderIds,
			allowedPluginProviderSources
		) =>
			createDefaultSessionProviderCollection(runtime, sessionId, {
				credentialStore: createInMemoryCredentialStore(credentials),
				modelStore,
				...(allowedPluginProviderIds === undefined
					? {}
					: { allowedPluginProviderIds }),
				...(allowedPluginProviderSources === undefined
					? {}
					: { allowedPluginProviderSources }),
			}),
		database: database.db,
		getConfig: () => ({
			configStore,
			homeRoot: HOME_ROOT,
			workspace: WORKSPACE,
		}),
		plugin: { ownedByCaller: true, runtime: pluginRuntime },
		workspace: WORKSPACE,
	});
	let collection: ProviderCollection | undefined;

	try {
		const collectionFactory = assembly.capabilities.createProviderCollection;
		if (collectionFactory === undefined) {
			throw new Error(
				"Session capabilities did not provide a collection factory."
			);
		}
		const createdCollection = await collectionFactory(
			pluginRuntime,
			"models-json-session"
		);
		if (createdCollection === undefined) {
			throw new Error("Session collection factory returned no collection.");
		}
		collection = createdCollection;
		expect(collection.getModels()).toContainEqual(
			expect.objectContaining({
				modelId: "user-model",
				providerId: "session-user-provider",
			})
		);
		expect(
			collection
				.getModels()
				.some(({ providerId }) => providerId === "session-project-provider")
		).toBe(false);
		expect(await collection.checkAuth("session-user-provider")).toMatchObject({
			status: "configured",
		});
		expect(
			(await collection.getAvailable("session-user-provider")).some(
				({ modelId }) => modelId === "user-model"
			)
		).toBe(true);
		expect(credentials.size).toBe(0);
	} finally {
		await collection?.close();
		await assembly.shutdown();
		database.sqlite.close();
	}
});

test("models.json API names route through their protocol adapters without rewriting model IDs", async () => {
	const requests: Array<{ body: Record<string, unknown>; url: string }> = [];
	const files = {
		[USER_MODELS_PATH]: JSON.stringify({
			providers: {
				"protocol-provider": {
					api: "openai-completions",
					apiKey: "test-key",
					baseUrl: "https://compatible.example/v1",
					models: [
						{ id: "compatible-model" },
						{
							api: "openai-chat",
							baseUrl: "https://openai.example/v1",
							id: "chat-model",
						},
						{
							api: "openai-responses",
							baseUrl: "https://openai.example/v1",
							id: "responses-model",
						},
						{
							api: "anthropic-messages",
							baseUrl: "https://anthropic.example/v1",
							id: "anthropic-model",
						},
						{
							api: "google-generative-ai",
							baseUrl: "https://google.example/v1beta/models",
							id: "google-model",
						},
						{
							api: "openai-compatible",
							baseUrl: "https://compatible.example/v1",
							id: "compatible-alias-model",
						},
						{
							api: "anthropic",
							baseUrl: "https://anthropic.example/v1",
							id: "anthropic-alias-model",
						},
						{
							api: "google",
							baseUrl: "https://google.example/v1beta/models",
							id: "google-alias-model",
						},
					],
				},
			},
		}),
	};
	const configuredProviders = await loadUserModelsJsonProviders(
		createConfigStoreWithFiles(files),
		WORKSPACE,
		{
			fetch: fakeFetch(async (input, init) => {
				const url = String(input);
				requests.push({
					body: JSON.parse(String(init?.body)) as Record<string, unknown>,
					url,
				});
				if (url.includes("anthropic.example")) {
					return sseResponse([
						{
							type: "message_start",
							message: { usage: { input_tokens: 1, output_tokens: 0 } },
						},
						{
							type: "content_block_start",
							index: 0,
							content_block: { type: "text", text: "" },
						},
						{
							type: "content_block_delta",
							index: 0,
							delta: { type: "text_delta", text: "Anthropic" },
						},
						{ type: "content_block_stop", index: 0 },
						{
							type: "message_delta",
							delta: { stop_reason: "end_turn" },
							usage: { output_tokens: 1 },
						},
						{ type: "message_stop" },
					]);
				}
				if (url.includes("google.example")) {
					return sseResponse([
						{
							candidates: [
								{
									content: { parts: [{ text: "Google" }], role: "model" },
									finishReason: "STOP",
								},
							],
						},
					]);
				}
				if (url.endsWith("/responses")) {
					return sseResponse([
						{ type: "response.output_text.delta", delta: "Responses" },
						{
							type: "response.completed",
							response: {
								output: [],
								usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
							},
						},
					]);
				}
				return compatibleStream();
			}),
		}
	);
	const collection = await createDefaultSessionProviderCollection(
		undefined,
		"protocol-alias-session",
		{
			configuredModelProviders: configuredProviders,
			credentialStore: createInMemoryCredentialStore(new Map()),
			modelStore,
		}
	);

	try {
		const configuredModels = collection
			.getModels()
			.filter(({ providerId }) => providerId === "protocol-provider");
		expect(
			configuredModels.map(({ modelId, protocolId }) => [modelId, protocolId])
		).toEqual([
			["compatible-model", "openai-compatible"],
			["chat-model", "openai-chat"],
			["responses-model", "openai-responses"],
			["anthropic-model", "anthropic"],
			["google-model", "google"],
			["compatible-alias-model", "openai-compatible"],
			["anthropic-alias-model", "anthropic"],
			["google-alias-model", "google"],
		]);
		for (const model of configuredModels) {
			const events: ChatEvent[] = [];
			for await (const event of collection.chat({
				messages: [
					{ content: [{ text: "hello", type: "text" }], role: "user" },
				],
				modelId: model.modelId,
				providerId: model.providerId,
			})) {
				events.push(event);
			}
			expect(events.at(-1)).toMatchObject({
				outcome: { status: "success" },
				type: "terminal",
			});
		}
		expect(requests.map(({ url }) => url)).toEqual([
			"https://compatible.example/v1/chat/completions",
			"https://openai.example/v1/chat/completions",
			"https://openai.example/v1/responses",
			"https://anthropic.example/v1/messages",
			"https://google.example/v1beta/models/google-model:streamGenerateContent?alt=sse",
			"https://compatible.example/v1/chat/completions",
			"https://anthropic.example/v1/messages",
			"https://google.example/v1beta/models/google-alias-model:streamGenerateContent?alt=sse",
		]);
		expect(requests.map(({ body }) => body.model)).toEqual([
			"compatible-model",
			"chat-model",
			"responses-model",
			"anthropic-model",
			undefined,
			"compatible-alias-model",
			"anthropic-alias-model",
			undefined,
		]);
	} finally {
		await collection.close();
	}
});
