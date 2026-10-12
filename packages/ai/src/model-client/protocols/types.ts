import type { SupportedPromptCacheRetentionTier } from "../../model-metadata";
import type {
	AnthropicProviderOptions,
	GoogleProviderOptions,
	OpenAIProviderOptions,
} from "../../model-provider-options";
import type { SupportedChatModel } from "../../models";
import type { ModelStepRequest, ModelStreamPart } from "../types";

export type ProtocolRequestContextByProtocol = {
	"openai-responses": Readonly<{
		maxOutputTokens: number | undefined;
		model: SupportedChatModel;
		omitOutputTokenLimit: boolean;
		providerOptions: OpenAIProviderOptions["openai"] | undefined;
		request: ModelStepRequest;
	}>;
	anthropic: Readonly<{
		maxOutputTokens: number | undefined;
		model: SupportedChatModel;
		providerOptions: AnthropicProviderOptions["anthropic"] | undefined;
		request: ModelStepRequest;
	}>;
	google: Readonly<{
		maxOutputTokens: number | undefined;
		providerOptions: GoogleProviderOptions["google"] | undefined;
		request: ModelStepRequest;
	}>;
	"openai-chat": Readonly<{
		maxOutputTokens: number | undefined;
		model: SupportedChatModel;
		request: ModelStepRequest;
	}>;
};

export type ModelProtocol = keyof ProtocolRequestContextByProtocol;

export type ModelProtocolPromptCacheRoute = Readonly<{
	cachedContentTtlFor?: (
		retention: SupportedPromptCacheRetentionTier
	) => string | undefined;
	hasControls: boolean;
	isRetentionSupported: (
		retention: SupportedPromptCacheRetentionTier
	) => boolean;
	retentionTtlMsFor: (
		retention: SupportedPromptCacheRetentionTier
	) => number | undefined;
}>;

export type ModelProtocolPromptCacheStrategy = Readonly<{
	canWarmRequest: boolean;
	routeForModel: (
		model: SupportedChatModel
	) => ModelProtocolPromptCacheRoute | undefined;
}>;

export type ModelProtocolStrategyFor<P extends ModelProtocol> = Readonly<{
	protocol: P;
	promptCache: ModelProtocolPromptCacheStrategy;
	serialize: (
		context: ProtocolRequestContextByProtocol[P]
	) => Record<string, unknown>;
	stream: (
		response: Response,
		signal?: AbortSignal
	) => AsyncIterable<ModelStreamPart>;
}>;

export type ModelProtocolStrategy<P extends ModelProtocol = ModelProtocol> = {
	[Protocol in P]: ModelProtocolStrategyFor<Protocol>;
}[P];
