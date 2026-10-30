import { apiKeyCredentialSchema } from "../credential-schemas.ts";
import {
	type Provider,
	type ProviderAuthorization,
	type ProviderChatContext,
	type ProviderChatHeaderContext,
	type ProviderChatRequest,
	ProviderError,
	type ProviderModel,
} from "../sdk.ts";
import type { ConfiguredProviderOptions as ConfiguredProviderOptionsType } from "../sdk-private/configured-protocol-adapters.ts";
import { createConfiguredProtocolAdapter } from "../sdk-private/configured-protocol-adapters.ts";

export type {
	ConfiguredFetch,
	ConfiguredProviderOptions,
} from "../sdk-private/configured-protocol-adapters.ts";
export { resolveConfiguredProtocolId } from "../sdk-private/configured-protocol-adapters.ts";

const API_KEY_CREDENTIAL = Object.freeze({
	apiKey: "configured",
	kind: "api-key",
});

type ConfiguredProviderRoute = Readonly<{
	delegate: Provider;
}>;

const routeKeyFor = (protocolId: string, baseUrl: string | undefined): string =>
	JSON.stringify([protocolId, baseUrl ?? null]);

const apiKeyFor = async (
	credential: unknown,
	resolveApiKey: ConfiguredProviderOptionsType["resolveApiKey"],
	signal: AbortSignal | undefined
): Promise<
	Readonly<{ apiKey: string; storedCredential: unknown }> | undefined
> => {
	const stored = apiKeyCredentialSchema.safeParse(credential);
	if (stored.success) {
		return { apiKey: stored.data.apiKey, storedCredential: credential };
	}
	if (resolveApiKey === undefined) {
		return;
	}
	const apiKey = await resolveApiKey(signal);
	return typeof apiKey === "string" && apiKey.length > 0
		? { apiKey, storedCredential: undefined }
		: undefined;
};

/**
 * Creates one Provider backed by the existing protocol adapters. It only
 * composes supported wire protocols; custom auth and new protocols remain Plugins.
 */
export const createConfiguredProvider = (
	options: ConfiguredProviderOptionsType
): Provider => {
	if (options.id.trim().length === 0) {
		throw new Error("Configured Provider ID must not be empty.");
	}
	if (options.models.length === 0) {
		throw new Error(`Configured Provider ${options.id} must declare models.`);
	}

	const groupedModels = new Map<
		string,
		{ baseUrl: string | undefined; models: ProviderModel[]; protocolId: string }
	>();
	const modelIds = new Set<string>();
	for (const model of options.models) {
		if (model.providerId !== options.id) {
			throw new Error(
				`Configured model ${model.modelId} must use Provider ID ${options.id}.`
			);
		}
		if (modelIds.has(model.modelId)) {
			throw new Error(
				`Configured Provider ${options.id} declares duplicate model ID ${model.modelId}.`
			);
		}
		modelIds.add(model.modelId);
		const baseUrl = options.modelBaseUrls?.[model.modelId] ?? options.baseUrl;
		const key = routeKeyFor(model.protocolId, baseUrl);
		const group = groupedModels.get(key) ?? {
			baseUrl,
			models: [],
			protocolId: model.protocolId,
		};
		group.models.push(model);
		groupedModels.set(key, group);
	}

	const routes: ConfiguredProviderRoute[] = [];
	const modelRoutes = new Map<string, ConfiguredProviderRoute>();
	try {
		for (const group of groupedModels.values()) {
			const route: ConfiguredProviderRoute = {
				delegate: createConfiguredProtocolAdapter(
					options,
					group.protocolId,
					group.baseUrl,
					group.models
				),
			};
			routes.push(route);
			for (const model of group.models) {
				modelRoutes.set(model.modelId, route);
			}
		}
	} catch (error) {
		void Promise.allSettled(routes.map(({ delegate }) => delegate.close?.()));
		throw error;
	}

	const routeFor = (
		model: ProviderModel | undefined
	): ConfiguredProviderRoute => {
		const route =
			model === undefined ? routes[0] : modelRoutes.get(model.modelId);
		if (route === undefined) {
			throw new ProviderError(
				"provider",
				`Configured Provider ${options.id} has no route for the selected model.`
			);
		}
		return route;
	};

	const close = async (): Promise<void> => {
		const results = await Promise.allSettled(
			routes.map(({ delegate }) => delegate.close?.())
		);
		const failures = results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : []
		);
		if (failures.length > 0) {
			throw new AggregateError(
				failures,
				`Configured Provider ${options.id} failed to close.`
			);
		}
	};

	return {
		canEnforceMaxOutputTokens: ({ credential, model }) => {
			const route = routeFor(model);
			const parsed = apiKeyCredentialSchema.safeParse(credential);
			return (
				route.delegate.canEnforceMaxOutputTokens?.({
					credential: parsed.success ? credential : API_KEY_CREDENTIAL,
					model,
				}) ?? false
			);
		},
		checkAuth: ({ credential }) =>
			apiKeyCredentialSchema.safeParse(credential).success ||
			options.resolveApiKey !== undefined,
		close,
		getChatHeaders: (context: ProviderChatHeaderContext) =>
			routeFor(context.model).delegate.getChatHeaders?.(context) ?? {},
		id: options.id,
		models: options.models,
		resolveAuthorization: async ({ credential, model, signal }) => {
			const route = routeFor(model);
			const apiKey = await apiKeyFor(credential, options.resolveApiKey, signal);
			if (apiKey === undefined) {
				return null;
			}
			const authorization = await route.delegate.resolveAuthorization({
				credential: { apiKey: apiKey.apiKey, kind: "api-key" },
				model,
				signal,
			});
			if (authorization === null) {
				return null;
			}
			return {
				authorization: authorization.authorization,
				...(authorization.headers === undefined
					? {}
					: { headers: authorization.headers }),
				...(apiKey.storedCredential === undefined
					? {}
					: { credential: apiKey.storedCredential }),
			} satisfies ProviderAuthorization;
		},
		streamChat: (request: ProviderChatRequest, context: ProviderChatContext) =>
			routeFor(context.model).delegate.streamChat(request, context),
	};
};
