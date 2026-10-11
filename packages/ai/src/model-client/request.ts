import { resolveModelProviderOptions } from "../model-provider-options";
import type { SupportedChatModel } from "../models";
import type { ModelProtocolStrategy } from "./protocols/types";
import { providerAdapterFor } from "./provider-adapters";
import { mergeProviderOptions } from "./provider-adapters/shared";
import type { ProviderRequestContext } from "./provider-adapters/types";
import type { ModelStepRequest } from "./types";

export type SerializedProviderRequest = Readonly<{
	init: Omit<RequestInit, "signal">;
	strategy: ModelProtocolStrategy;
	url: string;
	usesPromptCacheControls: boolean;
}>;

const hasPromptCacheControl = (value: unknown): boolean => {
	if (Array.isArray(value)) {
		return value.some(hasPromptCacheControl);
	}
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		Object.hasOwn(record, "cache_control") ||
		Object.hasOwn(record, "cachedContent") ||
		Object.hasOwn(record, "prompt_cache_key") ||
		Object.hasOwn(record, "prompt_cache_options") ||
		Object.hasOwn(record, "prompt_cache_breakpoint") ||
		Object.hasOwn(record, "prompt_cache_retention") ||
		Object.values(record).some(hasPromptCacheControl)
	);
};

const providerRequestContext = (
	request: ModelStepRequest,
	model: SupportedChatModel
): ProviderRequestContext => {
	const { target } = request;
	const resolved = resolveModelProviderOptions(model, {
		maxOutputTokens: target.maxOutputTokens,
		thinkingLevel: target.thinkingLevel,
	});
	return {
		maxOutputTokens: resolved.maxOutputTokens ?? target.maxOutputTokens,
		model,
		providerOptions: mergeProviderOptions(
			resolved.providerOptions,
			target.providerOptions
		),
		request,
	};
};

export const buildProviderRequest = (
	request: ModelStepRequest,
	model: SupportedChatModel
): SerializedProviderRequest => {
	const adapter = providerAdapterFor(request.target.providerId);
	const route = adapter.createRequest(providerRequestContext(request, model));
	return {
		strategy: route.strategy,
		url: route.url,
		usesPromptCacheControls: hasPromptCacheControl(route.body),
		init: {
			method: "POST",
			headers: route.headers,
			body: JSON.stringify(route.body),
		},
	};
};
