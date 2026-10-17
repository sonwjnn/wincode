import { providerModels as deepSeekProviderModels } from "../generated/deepseek.generated.ts";
import {
	createOpenAICompatibleProvider,
	type OpenAICompatibleFetch,
} from "../sdk-private/openai-compatible.ts";

const DEEPSEEK_PROVIDER_ID = "deepseek";
export type DeepSeekProviderOptions = Readonly<{
	baseUrl?: string;
	fetch?: OpenAICompatibleFetch;
}>;

/** Creates the DeepSeek SDK Provider with its offline chat/reasoner baseline. */
export const createDeepSeekProvider = (options: DeepSeekProviderOptions = {}) =>
	createOpenAICompatibleProvider({
		baseUrl: options.baseUrl ?? "https://api.deepseek.com/",
		fetch: options.fetch,
		models: deepSeekProviderModels,
		providerId: DEEPSEEK_PROVIDER_ID,
		providerName: "DeepSeek",
	});
