import type { SupportedChatModel } from "./catalog";
import type {
	ModelPromptCacheCapabilities,
	ModelPromptCacheProtocolCapabilities,
	OpenAIPromptCacheProtocol,
} from "./model-metadata";
import { getModelMetadata } from "./model-metadata-runtime";

export const modelPromptCacheCapabilitiesFor = (
	model: SupportedChatModel
): ModelPromptCacheCapabilities | undefined =>
	getModelMetadata(model)?.promptCache;

export const getOpenAIPromptCacheProtocolCapabilities = (
	model: SupportedChatModel,
	protocol: OpenAIPromptCacheProtocol
): ModelPromptCacheProtocolCapabilities | undefined =>
	modelPromptCacheCapabilitiesFor(model)?.protocols?.[protocol];
