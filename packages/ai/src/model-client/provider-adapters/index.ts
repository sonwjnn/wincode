import type { ConnectionProviderId, SupportedChatModel } from "../../models";
import type { ModelProtocolStrategy } from "../protocols/types";
import { anthropicAdapter } from "./anthropic";
import { googleAdapter } from "./google";
import { openAIAdapter } from "./openai";
import { openCodeGoAdapter } from "./opencode-go";
import type { ConnectionProviderAdapter } from "./types";

const providerAdapters: {
	[P in ConnectionProviderId]: ConnectionProviderAdapter<P>;
} = {
	openai: openAIAdapter,
	anthropic: anthropicAdapter,
	google: googleAdapter,
	"opencode-go": openCodeGoAdapter,
};

export const providerAdapterFor = <P extends ConnectionProviderId>(
	providerId: P
): ConnectionProviderAdapter<P> => providerAdapters[providerId];

export const modelProtocolStrategyFor = (
	model: SupportedChatModel
): ModelProtocolStrategy =>
	providerAdapterFor(model.connectionProviderId).strategyForModel(model);
