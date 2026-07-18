import type {
	ChatModelSelection,
	SupportedChatModel,
	SupportedChatModelId,
} from "../models";
import {
	findSupportedChatModel,
	findSupportedChatModelSelection,
	getChatModelRoute,
	normalizeChatModelSelection,
} from "../models";
import type { ResolvedModel, ResolverOptions } from "./providers/contract";
import { modelResolverByProvider } from "./providers/registry";

export type {
	ResolvedModel,
	ResolverOptions as DirectModelResolverOptions,
} from "./providers/contract";
export type { OpenAIResolverOptions } from "./providers/openai";
export { resolveOpenAIChatModel } from "./providers/openai";

export function resolveDirectChatModel(
	selection: ChatModelSelection,
	apiKey: string,
	options: ResolverOptions = {}
): ResolvedModel {
	const normalized = normalizeChatModelSelection(selection);
	if (!normalized) {
		throw new Error(
			`Unsupported direct chat model selection: ${selection.providerId}/${selection.modelId}`
		);
	}
	const model = findSupportedChatModelSelection(normalized);
	if (!model || getChatModelRoute(normalized) !== "direct") {
		throw new Error(
			`Chat model selection is not direct: ${normalized.providerId}/${normalized.modelId}`
		);
	}
	return modelResolverByProvider[model.provider].resolveWithApiKey(
		model,
		apiKey,
		options
	);
}
export function resolveSupportedChatModel(
	model: SupportedChatModel,
	options: ResolverOptions = {}
): ResolvedModel {
	const resolver = modelResolverByProvider[model.provider];
	if (!resolver) {
		throw new Error("Unsupported provider");
	}
	return resolver.resolveWithEnvironment(model, options);
}
export function isSupportedChatModel(
	modelId: string
): modelId is SupportedChatModelId {
	return findSupportedChatModel(modelId) !== null;
}
export function isSupportedChatModelSelection(
	selection: ChatModelSelection
): boolean {
	return findSupportedChatModelSelection(selection) !== null;
}
export function isHostChatModelSelection(
	selection: ChatModelSelection
): boolean {
	return getChatModelRoute(selection) === "hosted";
}
export function resolveHostChatModelSelection(
	modelId: string
): ChatModelSelection {
	const selection = normalizeChatModelSelection(modelId);
	if (!selection || getChatModelRoute(selection) !== "hosted") {
		throw new Error(`Unsupported host model: ${modelId}`);
	}
	return selection;
}
export function resolveWincodeChatModelSelection(
	modelId: string
): SupportedChatModel {
	const s = resolveHostChatModelSelection(modelId);
	const m = findSupportedChatModelSelection(s);
	if (!m || m.route !== "hosted") {
		throw new Error(`Unsupported host model: ${modelId}`);
	}
	return m;
}
export function resolveChatModel(modelId: string): ResolvedModel {
	const model = findSupportedChatModel(modelId);
	if (!model) {
		throw new Error(`Unsupported model: ${modelId}`);
	}
	return resolveSupportedChatModel(model);
}
