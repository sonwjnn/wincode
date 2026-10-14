import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import type {
	CredentialStore,
	ModelStore,
	Provider,
	ProviderModel,
} from "@wincode/ai/sdk";
import type {
	PluginProviderDescriptor,
	PluginRuntime,
} from "@/modules/plugins/runtime";
import {
	createInteractiveProviderController,
	type InteractiveProviderController,
} from "@/modules/providers/interactive-provider-controller";
import { createDefaultSessionProviderCollection } from "@/modules/sessions/provider-collection";

test("each Host gets fresh built-in and trusted Plugin Providers over shared app stores", async () => {
	const credentials = new Map<string, unknown>();
	const snapshots = new Map<string, readonly ProviderModel[]>();
	const credentialStore: CredentialStore = {
		delete: (providerId) => {
			credentials.delete(providerId);
		},
		get: (providerId) => credentials.get(providerId),
		set: (providerId, credential) => {
			credentials.set(providerId, credential);
		},
	};
	const modelStore: ModelStore = {
		get: (providerId) => snapshots.get(providerId),
		set: (providerId, models) => {
			snapshots.set(providerId, models);
		},
	};
	const pluginModel: ProviderModel = {
		modelId: "fixture-model",
		protocolId: "fixture-protocol",
		providerId: "trusted-fixture-provider",
	};
	const pluginInstances: Provider[] = [];
	let pluginCloseCalls = 0;
	const pluginRegistration: PluginProviderDescriptor = {
		connect: async () => undefined,
		createProvider: () => {
			const provider: Provider = {
				id: pluginModel.providerId,
				models: [pluginModel],
				resolveAuthorization: () => ({ authorization: {} }),
				async *streamChat() {
					yield { type: "finish" };
				},
				close: () => {
					pluginCloseCalls += 1;
				},
			};
			pluginInstances.push(provider);
			return provider;
		},
		displayName: "Trusted Fixture",
		pluginId: "trusted-fixture-plugin",
		providerId: pluginModel.providerId,
		sourceIdentity: "trusted-fixture-source",
		sourcePath: "trusted-fixture-source",
	};
	const runtimeSessionIds: (string | undefined)[] = [];
	const pluginRuntime = fromPartial<PluginRuntime>({
		getProviderRegistrations: (sessionId?: string) => {
			runtimeSessionIds.push(sessionId);
			return [pluginRegistration];
		},
	});
	const first = await createDefaultSessionProviderCollection(
		pluginRuntime,
		"first-host",
		{ credentialStore, modelStore }
	);
	const second = await createDefaultSessionProviderCollection(
		pluginRuntime,
		"second-host",
		{ credentialStore, modelStore }
	);

	try {
		const builtinProviderIds = new Set([
			...first.getModels().map(({ providerId }) => providerId),
			...first.getDiscoverableProviderIds(),
		]);
		for (const providerId of [
			"openai",
			"anthropic",
			"google",
			"opencode-go",
			"deepseek",
			"openrouter",
		]) {
			expect(builtinProviderIds.has(providerId)).toBe(true);
		}
		expect(builtinProviderIds.has("trusted-fixture-provider")).toBe(true);
		expect(runtimeSessionIds).toEqual(["first-host", "second-host"]);
		expect(pluginInstances).toHaveLength(2);
		expect(pluginInstances[0]).not.toBe(pluginInstances[1]);

		const firstController: InteractiveProviderController =
			createInteractiveProviderController(first);
		const secondController = createInteractiveProviderController(second);
		await first.setCredential("openai", {
			apiKey: "fake-openai-key",
			kind: "api-key",
		});
		expect(
			(await secondController.getAvailableModels()).some(
				({ providerId }) => providerId === "openai"
			)
		).toBe(true);
		expect(await firstController.getKnownModels()).toEqual(first.getModels());
	} finally {
		await Promise.all([first.close(), second.close()]);
	}

	expect(pluginCloseCalls).toBe(2);
	expect(credentials.get("openai")).toEqual({
		apiKey: "fake-openai-key",
		kind: "api-key",
	});
});
