import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import { toModelId } from "@wincode/agent-core";
import type { ProviderModel } from "@wincode/ai";
import { createPluginPromptSelectionTarget } from "@/modules/application/plugin-prompt-selection";
import type { PluginProviderDescriptor } from "@/modules/plugins/runtime";
import {
	createProviderModelSelectionSnapshot,
	type PluginProviderOwnerRegistration,
	type ProviderModelSelection,
	type ProviderModelSelectionCandidate,
	providerModelSelectionCandidateForModel,
} from "@/modules/providers/provider-model-selection";

const selectedModel: ProviderModelSelection = {
	modelId: toModelId("plugin-model"),
	providerId: "plugin-provider",
};

const availableModel: ProviderModel = {
	modelId: selectedModel.modelId,
	protocolId: "test",
	providerId: selectedModel.providerId,
};

const trustedOwner: PluginProviderOwnerRegistration = {
	pluginId: "trusted-plugin",
	providerId: "plugin-provider",
	sourceIdentity: "/trusted/plugins/provider.ts",
};

const hostRegistration = (
	owner: PluginProviderOwnerRegistration
): PluginProviderDescriptor =>
	fromPartial<PluginProviderDescriptor>({
		...owner,
		displayName: "Trusted Plugin Provider",
		sourcePath: owner.sourceIdentity,
	});

const providerController = (
	models: readonly ProviderModel[],
	registrations: readonly PluginProviderDescriptor[],
	onAvailability?: (providerId?: string) => void
) => {
	const ownerRegistrations = registrations.map(
		({ pluginId, providerId, sourceIdentity }) => ({
			pluginId,
			providerId,
			sourceIdentity,
		})
	);
	const snapshot = createProviderModelSelectionSnapshot(
		ownerRegistrations,
		ownerRegistrations,
		1
	);
	return {
		getAvailableProviderModelSelectionCandidates: async (
			providerId: string | undefined
		) => {
			onAvailability?.(providerId);
			return models
				.filter(
					(model) => providerId === undefined || model.providerId === providerId
				)
				.flatMap((model) => {
					const candidate = providerModelSelectionCandidateForModel(
						model,
						snapshot
					);
					return candidate === undefined ? [] : [candidate];
				});
		},
		getPluginProviderRegistrations: () => registrations,
		selectProviderModelSelectionCandidate: async <Result>(
			candidate: ProviderModelSelectionCandidate,
			action: (
				model: ProviderModel,
				selection: ProviderModelSelection
			) => Result | Promise<Result>
		): Promise<Result> => await action(candidate.model, candidate.selection),
	};
};

const createTarget = (
	models: readonly ProviderModel[],
	trustedRegistrations: readonly PluginProviderOwnerRegistration[],
	hostRegistrations: readonly PluginProviderDescriptor[],
	selectedModels: ProviderModelSelection[],
	onAvailability?: (providerId?: string) => void
) =>
	createPluginPromptSelectionTarget(
		providerController(models, hostRegistrations, onAvailability),
		{
			setModel: (model) => selectedModels.push(model),
			setThinkingLevel: () => undefined,
		},
		() => trustedRegistrations
	);

test("the focused composer rejects a Provider Model without trusted Host ownership before availability", async () => {
	const selectedModels: ProviderModelSelection[] = [];
	let availabilityCalls = 0;
	const target = createTarget(
		[availableModel],
		[],
		[hostRegistration(trustedOwner)],
		selectedModels,
		() => {
			availabilityCalls += 1;
		}
	);

	await expect(target.setModel(selectedModel)).resolves.toBe(false);
	expect(availabilityCalls).toBe(0);
	expect(selectedModels).toEqual([]);
});

test("the focused composer scopes availability to the fresh selected Provider before binding its trusted owner", async () => {
	const selectedModels: ProviderModelSelection[] = [];
	let availabilityCalls = 0;
	let requestedProviderId: string | undefined;
	const target = createTarget(
		[availableModel],
		[trustedOwner],
		[hostRegistration(trustedOwner)],
		selectedModels,
		(providerId) => {
			availabilityCalls += 1;
			requestedProviderId = providerId;
		}
	);

	await expect(target.setModel(selectedModel)).resolves.toBe(true);
	expect(availabilityCalls).toBe(1);
	expect(requestedProviderId).toBe(selectedModel.providerId);
	expect(selectedModels).toEqual([
		{
			...selectedModel,
			pluginProviderSource: {
				pluginId: trustedOwner.pluginId,
				sourceIdentity: trustedOwner.sourceIdentity,
			},
		},
	]);
});

test("the focused composer rejects stale owner provenance without availability or storage effects", async () => {
	const selectedModels: ProviderModelSelection[] = [];
	let availabilityCalls = 0;
	const target = createTarget(
		[availableModel],
		[trustedOwner],
		[hostRegistration(trustedOwner)],
		selectedModels,
		() => {
			availabilityCalls += 1;
		}
	);

	const staleSelection = {
		...selectedModel,
		pluginProviderSource: {
			pluginId: trustedOwner.pluginId,
			sourceIdentity: "/trusted/plugins/previous-provider.ts",
		},
	};
	await expect(target.setModel(staleSelection)).resolves.toBe(false);
	expect(availabilityCalls).toBe(0);
	expect(selectedModels).toEqual([]);
});

test("the focused composer rejects untrusted owner provenance before availability or storage", async () => {
	const selectedModels: ProviderModelSelection[] = [];
	let availabilityCalls = 0;
	const untrustedSelection = {
		...selectedModel,
		pluginProviderSource: {
			pluginId: "untrusted-plugin",
			sourceIdentity: "/untrusted/plugins/provider.ts",
		},
	};
	const target = createTarget(
		[availableModel],
		[trustedOwner],
		[hostRegistration(trustedOwner)],
		selectedModels,
		() => {
			availabilityCalls += 1;
		}
	);

	await expect(target.setModel(untrustedSelection)).resolves.toBe(false);
	expect(availabilityCalls).toBe(0);
	expect(selectedModels).toEqual([]);
});

test("the focused composer rejects ambiguous trusted owners before availability or storage", async () => {
	const selectedModels: ProviderModelSelection[] = [];
	let availabilityCalls = 0;
	const otherOwner = {
		...trustedOwner,
		pluginId: "second-trusted-plugin",
		sourceIdentity: "/trusted/plugins/second-provider.ts",
	};
	const target = createTarget(
		[availableModel],
		[trustedOwner, otherOwner],
		[hostRegistration(trustedOwner), hostRegistration(otherOwner)],
		selectedModels,
		() => {
			availabilityCalls += 1;
		}
	);

	await expect(target.setModel(selectedModel)).resolves.toBe(false);
	expect(availabilityCalls).toBe(0);
	expect(selectedModels).toEqual([]);
});

test("the focused composer rejects missing or mismatched Host ownership before availability", async () => {
	for (const hostRegistrations of [
		[],
		[
			hostRegistration({
				...trustedOwner,
				pluginId: "colliding-plugin",
				sourceIdentity: "/trusted/plugins/colliding-provider.ts",
			}),
		],
	]) {
		const selectedModels: ProviderModelSelection[] = [];
		let availabilityCalls = 0;
		const target = createTarget(
			[availableModel],
			[trustedOwner],
			hostRegistrations,
			selectedModels,
			() => {
				availabilityCalls += 1;
			}
		);

		await expect(target.setModel(selectedModel)).resolves.toBe(false);
		expect(availabilityCalls).toBe(0);
		expect(selectedModels).toEqual([]);
	}
});

test("the focused composer rejects built-in selection when an unrelated Plugin snapshot is missing or stale", async () => {
	const builtinSelection: ProviderModelSelection = {
		modelId: toModelId("gpt-5.6"),
		providerId: "openai",
	};
	const builtinModel: ProviderModel = {
		modelId: builtinSelection.modelId,
		protocolId: "openai",
		providerId: builtinSelection.providerId,
	};
	const unrelatedOwner: PluginProviderOwnerRegistration = {
		pluginId: "unrelated-plugin",
		providerId: "unrelated-provider",
		sourceIdentity: "/trusted/plugins/unrelated.ts",
	};
	for (const hostRegistrations of [
		[],
		[
			hostRegistration({
				...unrelatedOwner,
				sourceIdentity: "/trusted/plugins/old-unrelated.ts",
			}),
		],
	]) {
		const selectedModels: ProviderModelSelection[] = [];
		let availabilityCalls = 0;
		const target = createTarget(
			[builtinModel],
			[unrelatedOwner],
			hostRegistrations,
			selectedModels,
			() => {
				availabilityCalls += 1;
			}
		);

		await expect(target.setModel(builtinSelection)).resolves.toBe(false);
		expect(availabilityCalls).toBe(0);
		expect(selectedModels).toEqual([]);
	}
});

test("the focused composer keeps built-in selections ownerless", async () => {
	const selectedModels: ProviderModelSelection[] = [];
	const builtinSelection: ProviderModelSelection = {
		modelId: toModelId("gpt-5.6"),
		providerId: "openai",
	};
	const builtinModel: ProviderModel = {
		modelId: builtinSelection.modelId,
		protocolId: "openai",
		providerId: builtinSelection.providerId,
	};
	const target = createTarget([builtinModel], [], [], selectedModels);

	await expect(target.setModel(builtinSelection)).resolves.toBe(true);
	expect(selectedModels).toEqual([builtinSelection]);
});

test("the focused composer rejects a custom model that is not invocable", async () => {
	const selectedModels: ProviderModelSelection[] = [];
	const target = createTarget(
		[],
		[trustedOwner],
		[hostRegistration(trustedOwner)],
		selectedModels
	);

	await expect(target.setModel(selectedModel)).resolves.toBe(false);
	expect(selectedModels).toEqual([]);
});
