import { createReasoningSelection } from "../model-metadata-runtime";
import { resolveModelProviderOptions } from "../model-provider-options";
import type { SupportedChatModel } from "../models";
import type { ModelProtocolStrategy } from "./protocols/types";
import { providerAdapterFor } from "./provider-adapters";
import { mergeProviderOptions } from "./provider-adapters/shared";
import type { ProviderRequestContext } from "./provider-adapters/types";
import type { ModelStepRequest } from "./types";

type SerializedProviderRequest = Readonly<{
	init: Omit<RequestInit, "signal">;
	strategy: ModelProtocolStrategy;
	url: string;
}>;

const providerRequestContext = (
	request: ModelStepRequest,
	model: SupportedChatModel
): ProviderRequestContext => {
	const { target } = request;
	if (target.effort !== undefined && target.reasoningMode !== undefined) {
		throw new Error("Select either an Effort or a Reasoning Mode, not both.");
	}
	const reasoningSelection = createReasoningSelection(
		target.effort,
		target.reasoningMode
	);
	const resolved = resolveModelProviderOptions(model, {
		maxOutputTokens: target.maxOutputTokens,
		...reasoningSelection,
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
		init: {
			method: "POST",
			headers: route.headers,
			body: JSON.stringify(route.body),
		},
	};
};
