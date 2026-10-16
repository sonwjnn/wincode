import { expect, test } from "bun:test";
import type { ChatEvent, CredentialStore, Provider } from "@wincode/ai/sdk";
import type { PluginProviderDescriptor } from "@/modules/plugins/runtime";
import { createInteractiveSessionProviderCollection } from "@/modules/sessions/provider-collection";

const providerFor = (id: string): Provider => ({
	id,
	models: [],
	resolveAuthorization: () => null,
	async *streamChat() {
		yield { type: "finish" };
	},
});

const registrationFor = (
	pluginId: string,
	providerId: string,
	sourceIdentity: string
): PluginProviderDescriptor => ({
	connect: async () => undefined,
	createProvider: () => providerFor(providerId),
	displayName: `${pluginId} Provider`,
	pluginId,
	providerId,
	sourceIdentity,
	sourcePath: sourceIdentity,
});

const unusedCredentialStore: CredentialStore = {
	delete: () => undefined,
	get: () => undefined,
	set: () => undefined,
};

test("failed candidate Provider composition waits for every asynchronous close before rejecting", async () => {
	const releaseClose = Promise.withResolvers<void>();
	let closeStarted = 0;
	let closeSettled = 0;
	const closingRegistration = (pluginId: string): PluginProviderDescriptor => ({
		...registrationFor(
			pluginId,
			"duplicate_provider",
			`/trusted/${pluginId}.ts`
		),
		createProvider: () => ({
			...providerFor("duplicate_provider"),
			async close() {
				closeStarted += 1;
				await releaseClose.promise;
				closeSettled += 1;
			},
		}),
	});
	const collection = await createInteractiveSessionProviderCollection({
		credentialStore: unusedCredentialStore,
	});
	let rejectionObserved = false;
	const rejection = collection
		.preparePluginProviderRegistrations([
			closingRegistration("plugin_one"),
			closingRegistration("plugin_two"),
		])
		.catch((error: unknown) => {
			rejectionObserved = true;
			throw error;
		});

	try {
		await Bun.sleep(0);
		expect(closeStarted).toBe(2);
		expect(closeSettled).toBe(0);
		expect(rejectionObserved).toBe(false);
		releaseClose.resolve();
		await expect(rejection).rejects.toThrow(
			"Duplicate Provider ID 'duplicate_provider'."
		);
		expect(rejectionObserved).toBe(true);
		expect(closeSettled).toBe(2);
	} finally {
		releaseClose.resolve();
		await collection.close();
	}
});

test("fail-closed switches away from revoked Providers before asynchronous cleanup settles", async () => {
	const closeStarted = Promise.withResolvers<void>();
	const secondCloseStarted = Promise.withResolvers<void>();
	const releaseClose = Promise.withResolvers<void>();
	let closeCallsStarted = 0;
	let closeCallsSettled = 0;
	let discoveryCalls = 0;
	let authorizationCalls = 0;
	let streamCalls = 0;
	const providerId = "revoked_provider";
	const registration: PluginProviderDescriptor = {
		connect: async () => ({ apiKey: "fake-revoked-key" }),
		createProvider: () => ({
			id: providerId,
			models: [],
			discoverModels: () => {
				discoveryCalls += 1;
				return [];
			},
			resolveAuthorization: () => {
				authorizationCalls += 1;
				return { authorization: {} };
			},
			async *streamChat() {
				streamCalls += 1;
				yield { type: "finish" };
			},
			async close() {
				closeCallsStarted += 1;
				if (closeCallsStarted === 1) {
					closeStarted.resolve();
				} else {
					secondCloseStarted.resolve();
				}
				await releaseClose.promise;
				closeCallsSettled += 1;
			},
		}),
		displayName: "Revoked Provider",
		pluginId: "revoked_plugin",
		providerId,
		sourceIdentity: "/trusted/revoked.ts",
		sourcePath: "/trusted/revoked.ts",
	};
	const collection = await createInteractiveSessionProviderCollection({
		credentialStore: unusedCredentialStore,
		pluginProviders: [registration],
	});

	const prepared = await collection.preparePluginProviderRegistrations([
		registration,
	]);
	let closing: Promise<void> | undefined;
	let preparedCommit: Promise<void> | undefined;
	try {
		closing = collection.failClosed();
		expect(collection.getPluginProviderRegistrations()).toEqual([]);
		expect(collection.getPluginProviderComposition(providerId)).toBeUndefined();
		await expect(collection.refreshModels(providerId)).rejects.toThrow(
			`Unknown provider: ${providerId}`
		);
		const chatEvents: ChatEvent[] = [];
		for await (const event of collection.chat({
			messages: [],
			modelId: "revoked_model",
			providerId,
		})) {
			chatEvents.push(event);
		}
		expect(chatEvents.at(-1)).toMatchObject({
			outcome: {
				failure: { code: "provider-not-found", providerId },
				status: "failure",
			},
			type: "terminal",
		});
		await closeStarted.promise;
		preparedCommit = prepared.commit();
		await secondCloseStarted.promise;
		expect(collection.getPluginProviderRegistrations()).toEqual([]);
		expect(collection.getDiscoverableProviderIds()).toEqual([]);
		expect(closeCallsSettled).toBe(0);
		expect(discoveryCalls).toBe(0);
		expect(authorizationCalls).toBe(0);
		expect(streamCalls).toBe(0);
		releaseClose.resolve();
		await Promise.all([closing, preparedCommit]);
		expect(closeCallsSettled).toBe(2);
	} finally {
		releaseClose.resolve();
		await prepared.discard();
		await Promise.allSettled([
			collection.close(),
			preparedCommit ?? Promise.resolve(),
		]);
	}
});

test("duplicate Plugin Provider IDs fail closed across trusted sources and built-ins", async () => {
	const sourceOne = registrationFor(
		"plugin_one",
		"duplicate_provider",
		"/trusted/one.ts"
	);
	const sourceTwo = registrationFor(
		"plugin_two",
		"duplicate_provider",
		"/trusted/two.ts"
	);

	await expect(
		createInteractiveSessionProviderCollection({
			credentialStore: unusedCredentialStore,
			pluginProviders: [sourceOne, sourceTwo],
		})
	).rejects.toThrow("Duplicate Provider ID 'duplicate_provider'.");

	for (const providerId of [
		"openai",
		"anthropic",
		"google",
		"opencode-go",
		"deepseek",
		"openrouter",
	]) {
		await expect(
			createInteractiveSessionProviderCollection({
				credentialStore: unusedCredentialStore,
				pluginProviders: [
					registrationFor(
						`plugin_collision_${providerId}`,
						providerId,
						`/trusted/${providerId}.ts`
					),
				],
			})
		).rejects.toThrow(`Duplicate Provider ID '${providerId}'.`);
	}
});
