import { describe, expect, test } from "bun:test";
import type {
	CreateCachedContentParameters,
	DeleteCachedContentParameters,
} from "@google/genai";
import { ApiError } from "@google/genai";
import {
	createGoogleCachedContentResourceManager as createGoogleCacheManager,
	type GoogleCachedContentResourceManager,
	type GoogleCachedContentResourceManagerOptions,
} from "../src/sdk-private/google-cached-content-manager.ts";
import type { ProtocolTool } from "../src/sdk-private/protocols/request.ts";

const createManager = (
	options: Omit<GoogleCachedContentResourceManagerOptions, "cacheTtlForModel">
) =>
	createGoogleCacheManager({
		...options,
		cacheTtlForModel: (modelId, retention) => {
			if (!modelId.startsWith("gemini-3.8-")) {
				return;
			}
			return retention === "short" ? "300s" : "3600s";
		},
	});

const lookupTool: ProtocolTool = {
	description: "Find a record.",
	inputSchema: {
		properties: { query: { type: "string" } },
		required: ["query"],
		type: "object",
	},
	name: "lookup",
};

type CacheCalls = Readonly<{
	createCalls: CreateCachedContentParameters[];
	deleteCalls: DeleteCachedContentParameters[];
}>;

const createCacheClient = (calls: CacheCalls) => ({
	create: async (params: CreateCachedContentParameters) => {
		calls.createCalls.push(params);
		return { name: `cachedContents/${calls.createCalls.length}` };
	},
	delete: async (params: DeleteCachedContentParameters) => {
		calls.deleteCalls.push(params);
		return {};
	},
});

const select = (
	manager: GoogleCachedContentResourceManager,
	selection: Partial<
		Parameters<GoogleCachedContentResourceManager["select"]>[0]
	> = {}
) =>
	manager.select({
		apiKey: "google-key",
		cacheRetention: "short",
		modelId: "gemini-3.8-flash",
		providerId: "google",
		system: "Stable system instructions",
		tools: [lookupTool],
		...selection,
	});

describe("Google CachedContent resource lifecycle", () => {
	test("creates and reuses only the stable system and tool prefix", async () => {
		const calls: CacheCalls = { createCalls: [], deleteCalls: [] };
		const manager = createManager({
			createClient: () => createCacheClient(calls),
			sessionId: "session-one",
		});

		const first = await select(manager);
		const reused = await select(manager);

		expect(first?.name).toBe("cachedContents/1");
		expect(reused?.name).toBe("cachedContents/1");
		expect(calls.createCalls).toEqual([
			{
				model: "gemini-3.8-flash",
				config: {
					systemInstruction: "Stable system instructions",
					ttl: "300s",
					tools: [
						{
							functionDeclarations: [
								{
									name: "lookup",
									description: "Find a record.",
									parametersJsonSchema: lookupTool.inputSchema,
								},
							],
						},
					],
				},
			},
		]);
		expect(calls.createCalls[0]?.config).not.toHaveProperty("contents");
		await manager.close();
		expect(calls.deleteCalls).toEqual([{ name: "cachedContents/1" }]);
	});

	test("isolates in-flight CachedContent cleanup across Host-owned managers", async () => {
		const calls: CacheCalls = { createCalls: [], deleteCalls: [] };
		const creation = Promise.withResolvers<{ name: string }>();
		const createStarted = Promise.withResolvers<void>();
		let createCount = 0;
		const client = {
			create: async (params: CreateCachedContentParameters) => {
				calls.createCalls.push(params);
				createCount += 1;
				if (createCount === 1) {
					createStarted.resolve();
					return creation.promise;
				}
				return { name: `cachedContents/${createCount}` };
			},
			delete: async (params: DeleteCachedContentParameters) => {
				calls.deleteCalls.push(params);
				return {};
			},
		};
		const firstHostManager = createManager({
			createClient: () => client,
			sessionId: "first-host-session",
		});
		const secondHostManager = createManager({
			createClient: () => client,
			sessionId: "second-host-session",
		});

		const firstSelection = select(firstHostManager);
		await createStarted.promise;
		expect((await select(secondHostManager))?.name).toBe("cachedContents/2");
		const closingFirstHost = firstHostManager.close();
		creation.resolve({ name: "cachedContents/1" });

		expect(await firstSelection).toBeUndefined();
		await closingFirstHost;
		expect((await select(secondHostManager))?.name).toBe("cachedContents/2");
		expect(calls.createCalls).toHaveLength(2);
		expect(calls.deleteCalls).toEqual([{ name: "cachedContents/1" }]);

		await secondHostManager.close();
		expect(calls.deleteCalls).toEqual([
			{ name: "cachedContents/1" },
			{ name: "cachedContents/2" },
		]);
	});

	test("coalesces concurrent selections so close deletes the one owned resource", async () => {
		const calls: CacheCalls = { createCalls: [], deleteCalls: [] };
		const pendingCreations: PromiseWithResolvers<{ name: string }>[] = [];
		const createStarted = Promise.withResolvers<void>();
		const manager = createManager({
			createClient: () => ({
				create: async (params) => {
					calls.createCalls.push(params);
					const creation = Promise.withResolvers<{ name: string }>();
					pendingCreations.push(creation);
					createStarted.resolve();
					return creation.promise;
				},
				delete: async (params) => {
					calls.deleteCalls.push(params);
					return {};
				},
			}),
			sessionId: "session-one",
		});

		const selections = [select(manager), select(manager)];
		await createStarted.promise;
		await Bun.sleep(0);
		for (const [index, creation] of pendingCreations.entries()) {
			creation.resolve({ name: `cachedContents/${index + 1}` });
		}
		const [first, second] = await Promise.all(selections);

		expect(calls.createCalls).toHaveLength(1);
		expect(first?.name).toBe("cachedContents/1");
		expect(second?.name).toBe("cachedContents/1");
		await manager.close();
		expect(calls.deleteCalls).toEqual([{ name: "cachedContents/1" }]);
	});

	test("close waits for an in-flight creation and deletes its resource", async () => {
		const calls: CacheCalls = { createCalls: [], deleteCalls: [] };
		const creation = Promise.withResolvers<{ name: string }>();
		const createStarted = Promise.withResolvers<void>();
		const manager = createManager({
			createClient: () => ({
				create: async (params) => {
					calls.createCalls.push(params);
					createStarted.resolve();
					return creation.promise;
				},
				delete: async (params) => {
					calls.deleteCalls.push(params);
					return {};
				},
			}),
			sessionId: "session-one",
		});

		const selection = select(manager);
		await createStarted.promise;
		const closed = manager.close();
		creation.resolve({ name: "cachedContents/in-flight" });

		expect(await selection).toBeUndefined();
		await closed;
		expect(calls.deleteCalls).toEqual([{ name: "cachedContents/in-flight" }]);
	});

	test("serializes different identities and ignores invalidation for a replaced resource", async () => {
		const calls: CacheCalls = { createCalls: [], deleteCalls: [] };
		const manager = createManager({
			createClient: () => createCacheClient(calls),
			sessionId: "session-one",
		});

		const [first, second] = await Promise.all([
			select(manager, { system: "First system instructions" }),
			select(manager, { system: "Second system instructions" }),
		]);

		expect(first?.name).toBe("cachedContents/1");
		expect(second?.name).toBe("cachedContents/2");
		await first?.onRejected?.(first.name);
		await manager.close();
		expect(calls.deleteCalls).toEqual([
			{ name: "cachedContents/1" },
			{ name: "cachedContents/2" },
		]);
	});

	test("deletes and replaces a resource when the prefix, model, or retention changes", async () => {
		const calls: CacheCalls = { createCalls: [], deleteCalls: [] };
		const manager = createManager({
			createClient: () => createCacheClient(calls),
			sessionId: "session-one",
		});

		await select(manager);
		const changedPrefix = await select(manager, {
			system: "Updated system instructions",
		});
		expect(changedPrefix?.name).toBe("cachedContents/2");
		expect(calls.deleteCalls).toEqual([{ name: "cachedContents/1" }]);

		const changedModel = await select(manager, {
			modelId: "gemini-3.8-pro",
			system: "Updated system instructions",
		});
		expect(changedModel?.name).toBe("cachedContents/3");
		expect(calls.deleteCalls).toEqual([
			{ name: "cachedContents/1" },
			{ name: "cachedContents/2" },
		]);

		const changedRetention = await select(manager, {
			cacheRetention: "long",
			modelId: "gemini-3.8-pro",
			system: "Updated system instructions",
		});
		expect(changedRetention?.name).toBe("cachedContents/4");
		expect(calls.deleteCalls).toEqual([
			{ name: "cachedContents/1" },
			{ name: "cachedContents/2" },
			{ name: "cachedContents/3" },
		]);

		await manager.close();
	});

	test("invalidates only the rejected resource so the next turn creates a fresh one", async () => {
		const calls: CacheCalls = { createCalls: [], deleteCalls: [] };
		const manager = createManager({
			createClient: () => createCacheClient(calls),
			sessionId: "session-one",
		});
		const selected = await select(manager);

		await selected?.onRejected?.(selected.name);
		const replaced = await select(manager);

		expect(replaced?.name).toBe("cachedContents/2");
		expect(calls.deleteCalls).toEqual([{ name: "cachedContents/1" }]);
		await manager.close();
	});

	test("omits Wincode resources when policy or model metadata does not enable them", async () => {
		const calls: CacheCalls = { createCalls: [], deleteCalls: [] };
		const manager = createManager({
			createClient: () => createCacheClient(calls),
			sessionId: "session-one",
		});

		const enabled = await select(manager);
		const off = await select(manager, { cacheRetention: undefined });
		const unsupported = await select(manager, {
			modelId: "gemini-3.6-flash",
		});

		expect(enabled?.name).toBe("cachedContents/1");
		expect(off).toBeUndefined();
		expect(unsupported).toBeUndefined();
		expect(calls.createCalls).toHaveLength(1);
		expect(calls.deleteCalls).toEqual([{ name: "cachedContents/1" }]);
	});

	test("falls back uncached only on a recognized cache-creation rejection", async () => {
		const cacheError = new ApiError({
			message: "Cached content is unsupported for this model.",
			status: 400,
		});
		const manager = createManager({
			createClient: () => ({
				create: async () => {
					throw cacheError;
				},
				delete: async () => ({}),
			}),
			sessionId: "session-one",
		});

		expect(await select(manager)).toBeUndefined();
		await manager.close();

		const unrelated = new ApiError({
			message: "Cached content permission denied.",
			status: 403,
		});
		const failingManager = createManager({
			createClient: () => ({
				create: async () => {
					throw unrelated;
				},
				delete: async () => ({}),
			}),
			sessionId: "session-two",
		});
		await expect(select(failingManager)).rejects.toBe(unrelated);
		await failingManager.close();
	});
});
