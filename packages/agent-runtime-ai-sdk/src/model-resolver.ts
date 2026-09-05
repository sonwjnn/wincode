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
	if (target.providerOptions === undefined) {
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
	if (normalized === null) {
		throw new Error(
			`Unsupported direct chat model selection: ${selection.providerId}/${selection.modelId}`
		);
	}
	const model = findSupportedChatModelSelection(normalized);
	if (model === null || getChatModelRoute(normalized) !== "direct") {
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
	if (resolver === undefined) {
		throw new Error("Unsupported provider");
	}
	return resolver.resolveWithEnvironment(model, options);
};

export const isSupportedChatModel = (
	modelId: string
): modelId is SupportedChatModelId => findSupportedChatModel(modelId) !== null;

export const isSupportedChatModelSelection = (
	selection: ChatModelSelection
): boolean => findSupportedChatModelSelection(selection) !== null;

export const resolveChatModel = (modelId: string): ResolvedModel => {
	const model = findSupportedChatModel(modelId);
	if (model === null) {
		throw new Error(`Unsupported model: ${modelId}`);
	}
	return resolveSupportedChatModel(model);
};
