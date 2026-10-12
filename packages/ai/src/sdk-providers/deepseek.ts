import type { ProviderModel } from "../sdk.ts";
import {
	createOpenAICompatibleProvider,
	type OpenAICompatibleFetch,
	openAICompatibleProtocolId,
} from "../sdk-private/openai-compatible.ts";

const DEEPSEEK_PROVIDER_ID = "deepseek";
const DEEPSEEK_MODELS: readonly ProviderModel[] = [
	{
		capabilities: ["text", "tools"],
		modelId: "deepseek-chat",
		protocolId: openAICompatibleProtocolId,
		providerId: DEEPSEEK_PROVIDER_ID,
	},
	{
		capabilities: ["reasoning", "text", "tools"],
		modelId: "deepseek-reasoner",
		protocolId: openAICompatibleProtocolId,
		providerId: DEEPSEEK_PROVIDER_ID,
	},
];

export type DeepSeekProviderOptions = Readonly<{
	baseUrl?: string;
	fetch?: OpenAICompatibleFetch;
}>;

/** Creates the DeepSeek SDK Provider with its offline chat/reasoner baseline. */
export const createDeepSeekProvider = (options: DeepSeekProviderOptions = {}) =>
	createOpenAICompatibleProvider({
		baseUrl: options.baseUrl ?? "https://api.deepseek.com/",
		fetch: options.fetch,
		models: DEEPSEEK_MODELS,
		providerId: DEEPSEEK_PROVIDER_ID,
		providerName: "DeepSeek",
	});
