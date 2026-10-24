import {
	createProviderCollection,
	type Provider,
	type ProviderChatEvent,
	type ProviderChatRequest,
	type ProviderCollection,
	type ProviderModel,
} from "@wincode/ai";

export type FakeMessageRequest = {
	readonly role: string;
	readonly text: string;
};

export type FakeGenerationRequest =
	| {
			readonly kind: "chat";
			readonly messages: readonly FakeMessageRequest[];
	  }
	| {
			readonly kind: "summary";
			readonly system: string;
			readonly text: string;
	  };

export type FakeProviderRecorder = {
	readonly requests: FakeGenerationRequest[];
	readonly summaryText: string;
	/** A per-test hook that can hold a fake Provider request in flight. */
	beforeChat?: (request: ProviderChatRequest) => Promise<void>;
	/** A test-specific script for conversation-level integration journeys. */
	stepScript?: FakeProviderStepScript;
	/** Pauses after streamed text reaches the Session Snapshot. */
	afterTextDelta?: () => Promise<void>;
};

export type FakeProviderStepScript = (
	request: ProviderChatRequest,
	recorder: FakeProviderRecorder
) => AsyncGenerator<ProviderChatEvent>;

const requestText = (request: ProviderChatRequest): string =>
	request.messages
		.flatMap((message) =>
			message.content.flatMap((part) => {
				if (part.type === "text") {
					return [part.text];
				}
				if (part.type === "tool-result") {
					return [String(part.output)];
				}
				if (part.type === "tool-failure") {
					return [part.errorText];
				}
				return [];
			})
		)
		.join("\n");

const requestMessages = (request: ProviderChatRequest): FakeMessageRequest[] =>
	request.messages.map((message) => ({
		role: message.role,
		text: message.content
			.flatMap((part) => {
				if (part.type === "text") {
					return [part.text];
				}
				if (part.type === "tool-result") {
					return [String(part.output)];
				}
				if (part.type === "tool-failure") {
					return [part.errorText];
				}
				return [];
			})
			.join("\n"),
	}));

const isSummaryRequest = (request: ProviderChatRequest): boolean =>
	request.system?.includes("session summarizer") === true;

const defaultProviderStepScript: FakeProviderStepScript = async function* (
	request,
	recorder
): AsyncGenerator<ProviderChatEvent> {
	if (recorder.stepScript !== undefined) {
		yield* recorder.stepScript(request, recorder);
		return;
	}
	await recorder.beforeChat?.(request);
	if (isSummaryRequest(request)) {
		recorder.requests.push({
			kind: "summary",
			system: request.system ?? "",
			text: requestText(request),
		});
		yield { delta: recorder.summaryText, type: "text-delta" };
		yield {
			type: "usage",
			usage: { inputTokens: 10, outputTokens: 2 },
		};
		yield { completion: { kind: "completed" }, type: "finish" };
		return;
	}
	recorder.requests.push({
		kind: "chat",
		messages: requestMessages(request),
	});
	yield { delta: "E2E chat response", type: "text-delta" };
	await recorder.afterTextDelta?.();
	yield {
		type: "usage",
		usage: { inputTokens: 1, outputTokens: 1 },
	};
	yield { completion: { kind: "completed" }, type: "finish" };
};

export const createFakeProviderRecorder = (): FakeProviderRecorder => ({
	requests: [],
	summaryText: "E2E compacted summary",
});

const fakeProviderModel: ProviderModel = {
	capabilities: ["reasoning", "text", "tools"],
	limits: { contextWindowTokens: 200_000 },
	modelId: "gpt-5.6-luna",
	promptCacheRetentionTiers: ["short"],
	promptCacheRetentionTtlMs: { short: 30 * 60_000 },
	providerId: "openai",
	protocolId: "fake-e2e-provider",
	reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
};

export const createFakeProviderCollection = (
	recorder: FakeProviderRecorder,
	model: ProviderModel = fakeProviderModel,
	additionalModels: readonly ProviderModel[] = [],
	additionalProviders: readonly Provider[] = []
): ProviderCollection &
	Readonly<{ getPluginProviderRegistrations: () => readonly [] }> => {
	const models = [model, ...additionalModels];
	const modelsByProvider = new Map<string, ProviderModel[]>();
	for (const providerModel of models) {
		const providerModels = modelsByProvider.get(providerModel.providerId) ?? [];
		providerModels.push(providerModel);
		modelsByProvider.set(providerModel.providerId, providerModels);
	}
	const credentials = new Map<string, unknown>();
	const providers = createProviderCollection({
		credentialStore: {
			delete: (providerId) => {
				credentials.delete(providerId);
			},
			list: () =>
				[...new Set([...credentials.keys(), ...modelsByProvider.keys()])].map(
					(providerId) => ({ providerId, type: "unknown" })
				),
			modify: async (providerId, update) => {
				const current =
					credentials.get(providerId) ??
					(modelsByProvider.has(providerId)
						? "fake-e2e-provider-key"
						: undefined);
				const replacement = await update(current);
				if (replacement !== undefined) {
					credentials.set(providerId, replacement);
				}
				return credentials.get(providerId) ?? current;
			},
			read: (providerId) =>
				credentials.get(providerId) ??
				(modelsByProvider.has(providerId)
					? "fake-e2e-provider-key"
					: undefined),
		},
		modelStore: { get: () => undefined, set: () => undefined },
	});
	const providerOverrides = new Map(
		additionalProviders.map((provider) => [provider.id, provider])
	);
	for (const [providerId, providerModels] of modelsByProvider) {
		if (providerOverrides.has(providerId)) {
			continue;
		}
		const provider: Provider = {
			id: providerId,
			models: providerModels,
			resolveAuthorization: ({ credential }) =>
				credential === undefined ? null : { authorization: credential },
			async *streamChat(request): AsyncGenerator<ProviderChatEvent> {
				for await (const event of (
					recorder.stepScript ?? defaultProviderStepScript
				)(request, recorder)) {
					yield event.type === "finish" && event.completion === undefined
						? { ...event, completion: { kind: "completed" } }
						: event;
				}
			},
		};
		providers.register(provider);
	}
	for (const provider of additionalProviders) {
		providers.register(provider);
	}
	return {
		...providers,
		getPluginProviderRegistrations: (): readonly [] => [],
	};
};

let installedRecorder: FakeProviderRecorder | undefined;

/** Installs the fake Provider recorder used by the interactive test fixture. */
export const installFakeProviderRecorder = (
	recorder: FakeProviderRecorder,
	stepScript?: FakeProviderStepScript
): void => {
	if (stepScript !== undefined) {
		recorder.stepScript = stepScript;
	}
	installedRecorder = recorder;
};

/** Creates the next test Host's isolated fake ProviderCollection. */
export const createInstalledFakeProviderCollection = (
	model?: ProviderModel
): ProviderCollection &
	Readonly<{ getPluginProviderRegistrations: () => readonly [] }> => {
	if (installedRecorder === undefined) {
		throw new Error("The fake Provider recorder was not installed.");
	}
	return createFakeProviderCollection(installedRecorder, model);
};
