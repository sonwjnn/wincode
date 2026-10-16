import { expect, test } from "bun:test";
import type {
	CredentialStore,
	ModelStore,
	Provider,
	ProviderModel,
} from "@wincode/ai/sdk";
import {
	createPluginRuntime,
	type PluginProviderDescriptor,
} from "@/modules/plugins/runtime";
import {
	createInteractiveProviderController,
	type InteractiveProviderController,
} from "@/modules/providers/interactive-provider-controller";
import { pluginProviderStorageId } from "@/modules/providers/provider-stores";
import { createSessionHostManager } from "@/modules/sessions/host/session-host-manager";
import type { SessionHostManager } from "@/modules/sessions/host/types";
import {
	createInteractiveSessionProviderCollection,
	type InteractiveSessionProviderCollection,
} from "@/modules/sessions/provider-collection";
import { createInMemoryCredentialStore } from "../support/provider-stores";

const registrationFor = (
	pluginId: string,
	sourceIdentity: string,
	connect: PluginProviderDescriptor["connect"],
	onDiscover: () => void | Promise<void>
): PluginProviderDescriptor => ({
	connect,
	createProvider: () => providerFor(onDiscover),
	displayName: `${pluginId} Provider`,
	pluginId,
	providerId: "shared_provider",
	sourceIdentity,
	sourcePath: sourceIdentity,
});

const providerFor = (onDiscover: () => void | Promise<void>): Provider => ({
	async discoverModels() {
		await onDiscover();
		return [];
	},
	id: "shared_provider",
	models: [],
	resolveAuthorization: () => ({ authorization: {} }),
	async *streamChat() {
		yield { type: "finish" };
	},
});

const createMemoryStores = (
	beforeCredentialWrite?: (
		providerId: string,
		credential: unknown
	) => Promise<void>
): Readonly<{
	credentials: Map<string, unknown>;
	credentialStore: CredentialStore;
	modelStore: ModelStore;
}> => {
	const credentials = new Map<string, unknown>();
	const snapshots = new Map<string, readonly ProviderModel[]>();
	return {
		credentials,
		credentialStore: createInMemoryCredentialStore(
			credentials,
			beforeCredentialWrite
		),
		modelStore: {
			get: (providerId) => snapshots.get(providerId),
			set: (providerId, models) => {
				snapshots.set(providerId, models);
			},
		},
	};
};

const withSessionWork = async <Result>(
	manager: SessionHostManager,
	action: () => Promise<Result>
): Promise<Result> => {
	const admission = manager.tryAcquireSessionWork();
	if (admission.kind === "rejected") {
		throw new Error(admission.reason);
	}
	try {
		return await action();
	} finally {
		admission.release();
	}
};

const controllerFor = (
	collection: InteractiveSessionProviderCollection,
	manager: SessionHostManager,
	discoverableProviderIds?: () => readonly string[]
): InteractiveProviderController =>
	createInteractiveProviderController(collection, {
		getDiscoverableProviderIds:
			discoverableProviderIds ?? collection.getDiscoverableProviderIds,
		getPluginProviderRegistrations: collection.getPluginProviderRegistrations,
		getPluginProviderComposition: collection.getPluginProviderComposition,
		supportsModelDiscovery: collection.supportsModelDiscovery,
		withSessionWork: (action) => withSessionWork(manager, action),
	});

test("Provider controller exposes the current Plugin owner for explicit selection binding", async () => {
	const stores = createMemoryStores();
	const registration = registrationFor(
		"selection-owner-plugin",
		"/trusted/selection-owner.ts",
		async () => undefined,
		() => undefined
	);
	const collection = await createInteractiveSessionProviderCollection({
		credentialStore: stores.credentialStore,
		modelStore: stores.modelStore,
		pluginProviders: [registration],
	});
	const manager = createSessionHostManager();
	const controller = controllerFor(collection, manager);
	try {
		expect(
			controller.getPluginProviderComposition?.("shared_provider")?.registration
		).toMatchObject({
			pluginId: registration.pluginId,
			providerId: registration.providerId,
			sourceIdentity: registration.sourceIdentity,
		});
	} finally {
		await collection.close();
		await manager.shutdownAll();
	}
});

test("OpenRouter connect holds reload admission until asynchronous model discovery settles", async () => {
	const discoveryStarted = Promise.withResolvers<void>();
	const releaseDiscovery = Promise.withResolvers<void>();
	const stores = createMemoryStores();
	const collection = await createInteractiveSessionProviderCollection({
		credentialStore: stores.credentialStore,
		modelStore: stores.modelStore,
		openRouterProviderOptions: {
			fetch: async () => {
				discoveryStarted.resolve();
				await releaseDiscovery.promise;
				return Response.json({ data: [] });
			},
		},
	});
	const manager = createSessionHostManager();
	const controller = controllerFor(collection, manager);
	let reloadActionStarted = false;

	try {
		const openRouterConnectOption = controller
			.getConnectableProviders()
			.find(({ methodId }) => methodId === "openrouter-api-key");
		if (openRouterConnectOption?.kind !== "api-key-with-model-discovery") {
			throw new Error(
				"The OpenRouter discovery connection method was unavailable."
			);
		}
		const pendingConnect = openRouterConnectOption.connectApiKey(
			"fake-openrouter-key"
		);
		await discoveryStarted.promise;
		await expect(
			manager.withIdleForReload(async () => {
				reloadActionStarted = true;
			})
		).rejects.toThrow("Session work is being admitted");
		expect(reloadActionStarted).toBe(false);

		releaseDiscovery.resolve();
		await expect(pendingConnect).resolves.toEqual([]);
		await manager.withIdleForReload(async () => {
			reloadActionStarted = true;
		});
		expect(reloadActionStarted).toBe(true);
		expect(stores.credentials.get("openrouter")).toEqual({
			apiKey: "fake-openrouter-key",
			kind: "api-key",
		});
	} finally {
		releaseDiscovery.resolve();
		await collection.close();
		await manager.shutdownAll();
	}
});

test("a pending Plugin connect holds reload admission and cannot redirect credentials to a replacement owner", async () => {
	const started = Promise.withResolvers<void>();
	const releaseConnect = Promise.withResolvers<void>();
	const discoveryStarted = Promise.withResolvers<void>();
	const releaseDiscovery = Promise.withResolvers<void>();
	let ownerADiscoveries = 0;
	let ownerBDiscoveries = 0;
	const registrationA = registrationFor(
		"shared_plugin",
		"/trusted/source-a.ts",
		async () => {
			started.resolve();
			await releaseConnect.promise;
			return { apiKey: "fake-owner-a-key" };
		},
		async () => {
			discoveryStarted.resolve();
			await releaseDiscovery.promise;
			ownerADiscoveries += 1;
		}
	);
	const registrationB = registrationFor(
		"shared_plugin",
		"/trusted/source-b.ts",
		async () => ({ apiKey: "fake-owner-b-key" }),
		() => {
			ownerBDiscoveries += 1;
		}
	);
	const stores = createMemoryStores();
	const collection = await createInteractiveSessionProviderCollection({
		credentialStore: stores.credentialStore,
		modelStore: stores.modelStore,
		pluginProviders: [registrationA],
	});
	const manager = createSessionHostManager();
	const controller = controllerFor(collection, manager);

	try {
		const pendingConnect = controller.connectPluginProvider(
			"shared_provider",
			async () => "unused fake input"
		);
		await started.promise;
		await expect(
			manager.withIdleForReload(async () => undefined)
		).rejects.toThrow("Session work is being admitted");

		// Simulate a replacement racing past the manager gate: the operation must
		// retain the captured source-A collection rather than use the live facade.
		const replacement = await collection.preparePluginProviderRegistrations([
			registrationB,
		]);
		await replacement.commit();
		releaseConnect.resolve();
		await discoveryStarted.promise;
		await expect(
			manager.withIdleForReload(async () => undefined)
		).rejects.toThrow("Session work is being admitted");
		releaseDiscovery.resolve();
		await pendingConnect;

		expect(
			stores.credentials.get(
				pluginProviderStorageId({
					pluginId: "shared_plugin",
					providerId: "shared_provider",
					sourceIdentity: "/trusted/source-a.ts",
				})
			)
		).toEqual({ apiKey: "fake-owner-a-key" });
		expect(
			stores.credentials.has(
				pluginProviderStorageId({
					pluginId: "shared_plugin",
					providerId: "shared_provider",
					sourceIdentity: "/trusted/source-b.ts",
				})
			)
		).toBe(false);
		expect(ownerADiscoveries).toBe(1);
		expect(ownerBDiscoveries).toBe(0);
	} finally {
		releaseConnect.resolve();
		releaseDiscovery.resolve();
		await collection.close();
		await manager.shutdownAll();
	}
});

test("aborting during a successful credential write reports saved and skips discovery", async () => {
	const writeStarted = Promise.withResolvers<void>();
	const releaseWrite = Promise.withResolvers<void>();
	let discoveries = 0;
	const stores = createMemoryStores(async () => {
		writeStarted.resolve();
		await releaseWrite.promise;
	});
	const registration = registrationFor(
		"persisted_plugin",
		"/trusted/persisted.ts",
		async () => ({ apiKey: "fake-persisted-key" }),
		() => {
			discoveries += 1;
		}
	);
	const collection = await createInteractiveSessionProviderCollection({
		credentialStore: stores.credentialStore,
		modelStore: stores.modelStore,
		pluginProviders: [registration],
	});
	const manager = createSessionHostManager();
	const controller = controllerFor(collection, manager);
	const abortController = new AbortController();

	try {
		const pendingConnect = controller.connectPluginProvider(
			"shared_provider",
			async () => "unused fake input",
			{ signal: abortController.signal }
		);
		await writeStarted.promise;
		abortController.abort(new DOMException("dialog dismissed", "AbortError"));
		await expect(
			manager.withIdleForReload(async () => undefined)
		).rejects.toThrow("Session work is being admitted");
		releaseWrite.resolve();
		expect(await pendingConnect).toEqual({ kind: "saved-before-cancelled" });
		expect(
			stores.credentials.get(
				pluginProviderStorageId({
					pluginId: "persisted_plugin",
					providerId: "shared_provider",
					sourceIdentity: "/trusted/persisted.ts",
				})
			)
		).toEqual({ apiKey: "fake-persisted-key" });
		expect(discoveries).toBe(0);
	} finally {
		releaseWrite.resolve();
		await collection.close();
		await manager.shutdownAll();
	}
});

test("Plugin model discovery holds reload admission through trust revocation", async () => {
	const discoveryGates = Array.from({ length: 2 }, () => ({
		release: Promise.withResolvers<void>(),
		started: Promise.withResolvers<void>(),
	}));
	let discoveryIndex = 0;
	const registration = registrationFor(
		"refresh_plugin",
		"/trusted/refresh.ts",
		async () => undefined,
		async () => {
			const gate = discoveryGates[discoveryIndex];
			if (gate === undefined) {
				throw new Error("No fake discovery gate is available.");
			}
			discoveryIndex += 1;
			gate.started.resolve();
			await gate.release.promise;
		}
	);
	const stores = createMemoryStores();
	const collection = await createInteractiveSessionProviderCollection({
		credentialStore: stores.credentialStore,
		modelStore: stores.modelStore,
		pluginProviders: [registration],
	});
	const manager = createSessionHostManager();
	const revokedRuntime = createPluginRuntime([], []);
	const controller = controllerFor(collection, manager, () => [
		"shared_provider",
	]);
	let revocationActionStarted = false;

	try {
		const refreshOperations = [
			() => controller.refreshModels(),
			() => controller.refreshProviderModels("shared_provider"),
		];
		for (const [index, refresh] of refreshOperations.entries()) {
			const gate = discoveryGates[index];
			if (gate === undefined) {
				throw new Error("No fake discovery gate is available.");
			}
			const pendingRefresh = refresh();
			await gate.started.promise;
			await expect(
				manager.withIdleForReload(async () => {
					revocationActionStarted = true;
					await manager.replacePluginRuntime(revokedRuntime, {
						trustChanged: true,
					});
				})
			).rejects.toThrow("Session work is being admitted");
			expect(revocationActionStarted).toBe(false);
			gate.release.resolve();
			await pendingRefresh;
		}

		await manager.withIdleForReload(async () => {
			revocationActionStarted = true;
			await manager.replacePluginRuntime(revokedRuntime, {
				trustChanged: true,
			});
		});
		expect(revocationActionStarted).toBe(true);
	} finally {
		for (const gate of discoveryGates) {
			gate.release.resolve();
		}
		await collection.close();
		await manager.shutdownAll();
		await revokedRuntime.shutdown();
	}
});

test("partial Provider model refresh keeps successful models visible to the picker", async () => {
	const workingModel: ProviderModel = {
		capabilities: ["text", "tools"],
		modelId: "working_model",
		protocolId: "fake-plugin-provider",
		providerId: "working_provider",
	};
	const providerRegistration = (
		pluginId: string,
		providerId: string,
		discoverModels: Provider["discoverModels"]
	): PluginProviderDescriptor => ({
		connect: async () => undefined,
		createProvider: () => ({
			id: providerId,
			models: [],
			discoverModels,
			resolveAuthorization: () => ({ authorization: {} }),
			async *streamChat() {
				yield { type: "finish" };
			},
		}),
		displayName: `${pluginId} Provider`,
		pluginId,
		providerId,
		sourceIdentity: `/trusted/${pluginId}.ts`,
		sourcePath: `/trusted/${pluginId}.ts`,
	});
	const stores = createMemoryStores();
	const collection = await createInteractiveSessionProviderCollection({
		credentialStore: stores.credentialStore,
		modelStore: stores.modelStore,
		pluginProviders: [
			providerRegistration("offline", "offline_provider", async () => {
				throw new Error("fake provider is offline");
			}),
			providerRegistration("working", "working_provider", () => [workingModel]),
		],
	});
	const allProvidersController = createInteractiveProviderController(
		collection,
		{
			getDiscoverableProviderIds: () => [
				"offline_provider",
				"working_provider",
			],
		}
	);
	const offlineOnlyController = createInteractiveProviderController(
		collection,
		{
			getDiscoverableProviderIds: () => ["offline_provider"],
		}
	);

	try {
		await collection.setCredential("working_provider", { apiKey: "fake-key" });
		const refreshedModels = await allProvidersController.refreshModels();
		expect(refreshedModels.map(({ modelId }) => modelId)).toContain(
			"working_model"
		);
		expect(
			(await allProvidersController.getAvailableModels()).map(
				({ modelId }) => modelId
			)
		).toContain("working_model");
		await expect(offlineOnlyController.refreshModels()).rejects.toThrow(
			"Known Model refresh failed"
		);
		expect(
			(await allProvidersController.getAvailableModels()).map(
				({ modelId }) => modelId
			)
		).toContain("working_model");
	} finally {
		await collection.close();
	}
});

test("aborting a delayed Plugin connect leaves credentials and Known Models unchanged", async () => {
	const started = Promise.withResolvers<void>();
	const releaseConnect = Promise.withResolvers<void>();
	let discoveries = 0;
	const registration = registrationFor(
		"cancelled_plugin",
		"/trusted/cancelled.ts",
		async () => {
			started.resolve();
			await releaseConnect.promise;
			return { apiKey: "fake-cancelled-key" };
		},
		() => {
			discoveries += 1;
		}
	);
	const stores = createMemoryStores();
	const collection = await createInteractiveSessionProviderCollection({
		credentialStore: stores.credentialStore,
		modelStore: stores.modelStore,
		pluginProviders: [registration],
	});
	const manager = createSessionHostManager();
	const controller = controllerFor(collection, manager);
	const abortController = new AbortController();

	try {
		const pendingConnect = controller.connectPluginProvider(
			"shared_provider",
			async () => "unused fake input",
			{ signal: abortController.signal }
		);
		await started.promise;
		abortController.abort(new DOMException("dialog dismissed", "AbortError"));
		releaseConnect.resolve();
		expect(await pendingConnect).toBeUndefined();
		expect(stores.credentials.size).toBe(0);
		expect(discoveries).toBe(0);
	} finally {
		releaseConnect.resolve();
		await collection.close();
		await manager.shutdownAll();
	}
});
