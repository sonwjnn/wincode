import type { ModelTarget } from "@wincode/ai/model-target";
import type {
	ChatModelSelection,
	SupportedChatModel,
	SupportedChatModelId,
} from "@wincode/ai/models";
import {
	findSupportedChatModel,
	findSupportedChatModelSelection,
	getChatModelRoute,
	normalizeChatModelSelection,
} from "@wincode/ai/models";
import { isNull, isUndefined } from "@wincode/runtime-utils";
import {
	type ResolvedModel,
	type ResolverOptions,
	toAiSdkProviderOptions,
} from "./providers/contract";
import { resolveOpenAIChatModel } from "./providers/openai";
import { modelResolverByProvider } from "./providers/registry";

export type { ResolvedModel } from "./providers/contract";
export type { OpenAIResolverOptions } from "./providers/openai";
export { resolveOpenAIChatModel } from "./providers/openai";

export const resolveAiSdkModelTarget = (target: ModelTarget): ResolvedModel => {
	const options: ResolverOptions = {
		maxOutputTokens: target.maxOutputTokens,
		variant: target.variant,
	};
	let resolved: ResolvedModel;
	if (target.authorization.kind === "oauth") {
		if (target.providerId !== "openai") {
			throw new Error("OAuth authorization is only supported by OpenAI.");
		}
		resolved = resolveOpenAIChatModel(
			target.modelId,
			{
				accessToken: target.authorization.accessToken,
				accountId: target.authorization.accountId,
			},
			options
		);
	} else {
		resolved = resolveDirectChatModel(
			{
				modelId: target.modelId,
				providerId: target.providerId,
			},
			target.authorization.apiKey,
			options
		);
	}
	if (isUndefined(target.providerOptions)) {
		return resolved;
	}
	return {
		...resolved,
		providerOptions: toAiSdkProviderOptions(target.providerOptions),
	};
};

export const resolveDirectChatModel = (
	selection: ChatModelSelection,
	apiKey: string,
	options: ResolverOptions = {}
): ResolvedModel => {
	const normalized = normalizeChatModelSelection(selection);
	if (isNull(normalized)) {
		throw new Error(
			`Unsupported direct chat model selection: ${selection.providerId}/${selection.modelId}`
		);
	}
	const model = findSupportedChatModelSelection(normalized);
	if (isNull(model) || getChatModelRoute(normalized) !== "direct") {
		throw new Error(
			`Chat model selection is not direct: ${normalized.providerId}/${normalized.modelId}`
		);
	}
	return modelResolverByProvider[model.provider].resolveWithApiKey(
		model,
		apiKey,
		options
	);
};

export const resolveSupportedChatModel = (
	model: SupportedChatModel,
	options: ResolverOptions = {}
): ResolvedModel => {
	const resolver = modelResolverByProvider[model.provider];
	if (isUndefined(resolver)) {
		throw new Error("Unsupported provider");
	}
	return resolver.resolveWithEnvironment(model, options);
};

export const isSupportedChatModel = (
	modelId: string
): modelId is SupportedChatModelId => !isNull(findSupportedChatModel(modelId));

export const isSupportedChatModelSelection = (
	selection: ChatModelSelection
): boolean => !isNull(findSupportedChatModelSelection(selection));

export const resolveChatModel = (modelId: string): ResolvedModel => {
	const model = findSupportedChatModel(modelId);
	if (isNull(model)) {
		throw new Error(`Unsupported model: ${modelId}`);
	}
	return resolveSupportedChatModel(model);
};
