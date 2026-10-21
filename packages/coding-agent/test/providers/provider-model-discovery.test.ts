import { expect, test } from "bun:test";
import {
	createProviderCollection,
	type Provider,
	type ProviderModel,
} from "@wincode/ai";
import {
	createInteractiveProviderController,
	type InteractiveProviderController,
} from "@/modules/providers/interactive-provider-controller";
import { STALE_PROVIDER_MODEL_SELECTION_MESSAGE } from "@/modules/providers/provider-model-selection";
import { createInMemoryCredentialStore } from "@/test/support/provider-stores";

const PROVIDER_ID = "openrouter";
type DiscoverModels = NonNullable<Provider["discoverModels"]>;

const createDiscoveryHarness = (
	discoverModels: DiscoverModels,
	initialModels?: readonly ProviderModel[],
	hasCredential = true
) => {
	const storedModels = new Map<string, readonly ProviderModel[]>();
	if (initialModels !== undefined) {
		storedModels.set(PROVIDER_ID, initialModels);
	}
	const credentials = new Map<string, unknown>();
	if (hasCredential) {
		credentials.set(PROVIDER_ID, "fake-provider-credential");
	}
	const providers = createProviderCollection({
		credentialStore: createInMemoryCredentialStore(credentials),
		modelStore: {
			get: (id) => storedModels.get(id),
			set: (id, models) => void storedModels.set(id, models),
		},
	});
	const provider: Provider = {
		discoverModels,
		id: PROVIDER_ID,
		models: [],
		resolveAuthorization: async ({ credential }) =>
			credential === undefined ? null : { authorization: credential },
		async *streamChat() {
			yield { type: "finish" };
		},
	};
	providers.register(provider);
	const controller = createInteractiveProviderController(providers, {
		getDiscoverableProviderIds: () => [PROVIDER_ID],
		withSessionWork: async (action) => action(),
	});
	return { controller, providers, storedModels };
};

const selectionOperationsFor = (controller: InteractiveProviderController) => {
	const getCandidates = controller.getAvailableProviderModelSelectionCandidates;
	const refreshCandidates = controller.refreshProviderModelSelectionCandidates;
	const selectCandidate = controller.selectProviderModelSelectionCandidate;
	if (
		getCandidates === undefined ||
		refreshCandidates === undefined ||
		selectCandidate === undefined
	) {
		throw new Error("Provider Model selection is unavailable.");
	}
	return { getCandidates, refreshCandidates, selectCandidate };
};

test("an unconnected discoverable provider does not become a picker refresh failure", async () => {
	let discoveryCalls = 0;
	const { controller, providers } = createDiscoveryHarness(
		async () => {
			discoveryCalls += 1;
			throw new Error("OpenRouter requires an API key");
		},
		undefined,
		false
	);

	try {
		const { refreshCandidates } = selectionOperationsFor(controller);
		const result = await refreshCandidates();
		expect(discoveryCalls).toBe(0);
		expect(result.failedProviderIds).toEqual([]);
		expect(result.refreshedProviderIds).toEqual([]);
	} finally {
		await providers.close();
	}
});

test("a model removed by discovery cannot be selected from a stale candidate", async () => {
	const lastKnownModel: ProviderModel = {
		modelId: "retired-model",
		protocolId: "fixture-wire",
		providerId: PROVIDER_ID,
	};
	const { controller, providers, storedModels } = createDiscoveryHarness(
		async () => [],
		[lastKnownModel]
	);

	try {
		const { getCandidates, refreshCandidates, selectCandidate } =
			selectionOperationsFor(controller);
		const [staleCandidate] = await getCandidates();
		if (staleCandidate === undefined) {
			throw new Error("The stored Provider Model should be selectable.");
		}
		expect(staleCandidate.model).toEqual(lastKnownModel);

		await refreshCandidates();
		expect(storedModels.get(PROVIDER_ID)).toEqual([]);
		await expect(
			selectCandidate(staleCandidate, (_model, selection) => selection)
		).rejects.toThrow(STALE_PROVIDER_MODEL_SELECTION_MESSAGE);
	} finally {
		await providers.close();
	}
});

test("selection uses refreshed metadata when the exact model identity remains available", async () => {
	const originalModel: ProviderModel = {
		limits: { contextWindowTokens: 8000 },
		modelId: "stable-model",
		protocolId: "fixture-wire",
		providerId: PROVIDER_ID,
	};
	const refreshedModel: ProviderModel = {
		...originalModel,
		limits: { contextWindowTokens: 64_000 },
	};
	let discoveredModels: readonly ProviderModel[] = [originalModel];
	const { controller, providers } = createDiscoveryHarness(
		async () => discoveredModels
	);

	try {
		const { getCandidates, refreshCandidates, selectCandidate } =
			selectionOperationsFor(controller);
		const refresh = await providers.refreshModels({
			providerIds: [PROVIDER_ID],
		});
		expect(refresh.errors.size).toBe(0);
		const [candidate] = await getCandidates();
		if (candidate === undefined) {
			throw new Error("The discovered Provider Model should be selectable.");
		}

		discoveredModels = [refreshedModel];
		await refreshCandidates();
		await expect(selectCandidate(candidate, (model) => model)).resolves.toEqual(
			refreshedModel
		);
	} finally {
		await providers.close();
	}
});

test("failed or cancelled discovery leaves last-known model candidates selectable", async () => {
	const lastKnownModel: ProviderModel = {
		modelId: "last-known-model",
		protocolId: "fixture-wire",
		providerId: PROVIDER_ID,
	};
	const cancellationStarted = Promise.withResolvers<void>();
	const pendingDiscovery = Promise.withResolvers<readonly ProviderModel[]>();
	let discoveryMode: "cancel" | "fail" = "fail";
	const { controller, providers, storedModels } = createDiscoveryHarness(
		async ({ signal }) => {
			if (discoveryMode === "fail") {
				throw new Error("discovery endpoint unavailable");
			}
			if (signal === undefined) {
				throw new Error("discovery did not receive cancellation");
			}
			const rejectOnAbort = () =>
				pendingDiscovery.reject(
					signal.reason ?? new DOMException("Aborted", "AbortError")
				);
			signal.addEventListener("abort", rejectOnAbort, { once: true });
			if (signal.aborted) {
				rejectOnAbort();
			}
			cancellationStarted.resolve();
			return pendingDiscovery.promise;
		},
		[lastKnownModel]
	);

	try {
		const { getCandidates, refreshCandidates, selectCandidate } =
			selectionOperationsFor(controller);
		const [candidate] = await getCandidates();
		if (candidate === undefined) {
			throw new Error("The stored Provider Model should be selectable.");
		}

		const refreshResult = await refreshCandidates();
		expect(refreshResult.failedProviderIds).toEqual([PROVIDER_ID]);
		expect(refreshResult.refreshedProviderIds).toEqual([]);
		expect(refreshResult.candidates.map(({ model }) => model)).toEqual([
			lastKnownModel,
		]);
		expect(storedModels.get(PROVIDER_ID)).toEqual([lastKnownModel]);
		await expect(selectCandidate(candidate, (model) => model)).resolves.toEqual(
			lastKnownModel
		);

		discoveryMode = "cancel";
		const abortController = new AbortController();
		const cancelledRefresh = refreshCandidates({
			signal: abortController.signal,
		});
		await cancellationStarted.promise;
		abortController.abort(new DOMException("refresh cancelled", "AbortError"));
		await expect(cancelledRefresh).rejects.toThrow("refresh cancelled");
		expect(storedModels.get(PROVIDER_ID)).toEqual([lastKnownModel]);
		await expect(selectCandidate(candidate, (model) => model)).resolves.toEqual(
			lastKnownModel
		);
	} finally {
		await providers.close();
	}
});

test("partial discovery refresh updates successes and reports cached failures", async () => {
	const successfulProviderId = "openrouter";
	const failedProviderId = "deepseek";
	const refreshedModel: ProviderModel = {
		modelId: "refreshed-model",
		protocolId: "fixture-wire",
		providerId: successfulProviderId,
	};
	const lastKnownFailedModel: ProviderModel = {
		modelId: "last-known-failed-model",
		protocolId: "fixture-wire",
		providerId: failedProviderId,
	};
	const credentials = new Map<string, unknown>([
		[successfulProviderId, "fixture-credential"],
		[failedProviderId, "fixture-credential"],
	]);
	const storedModels = new Map<string, readonly ProviderModel[]>([
		[successfulProviderId, []],
		[failedProviderId, [lastKnownFailedModel]],
	]);
	const providers = createProviderCollection({
		credentialStore: createInMemoryCredentialStore(credentials),
		modelStore: {
			get: (providerId) => storedModels.get(providerId),
			set: (providerId, models) => void storedModels.set(providerId, models),
		},
	});
	const registerProvider = (
		providerId: string,
		discoverModels: DiscoverModels
	): void => {
		providers.register({
			discoverModels,
			id: providerId,
			models: [],
			resolveAuthorization: async ({ credential }) =>
				credential === undefined ? null : { authorization: credential },
			async *streamChat() {
				yield { type: "finish" };
			},
		});
	};
	registerProvider(successfulProviderId, async () => [refreshedModel]);
	registerProvider(failedProviderId, async () => {
		throw new Error("discovery endpoint unavailable");
	});
	const controller = createInteractiveProviderController(providers, {
		getDiscoverableProviderIds: () => [successfulProviderId, failedProviderId],
		withSessionWork: async (action) => action(),
	});

	try {
		const { refreshCandidates } = selectionOperationsFor(controller);
		const result = await refreshCandidates();
		expect(result.failedProviderIds).toEqual([failedProviderId]);
		expect(result.refreshedProviderIds).toEqual([successfulProviderId]);
		expect(result.candidates.map(({ model }) => model.modelId).sort()).toEqual([
			"last-known-failed-model",
			"refreshed-model",
		]);
		expect(storedModels.get(successfulProviderId)).toEqual([refreshedModel]);
		expect(storedModels.get(failedProviderId)).toEqual([lastKnownFailedModel]);
	} finally {
		await providers.close();
	}
});
