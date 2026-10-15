import type { SupportedPromptCacheRetentionTier } from "../../model-metadata.ts";
import type { ProviderModel } from "../../sdk.ts";
import type {
	AnthropicProtocolOptions,
	GoogleProtocolOptions,
	OpenAIProtocolOptions,
} from "./provider-options.ts";
import type { ProtocolStreamPart, ProviderProtocolRequest } from "./request.ts";

export type ProviderProtocolRequestContextByProtocol = {
	"openai-responses": Readonly<{
		maxOutputTokens: number | undefined;
		model: ProviderModel;
		omitOutputTokenLimit: boolean;
		providerOptions: OpenAIProtocolOptions | undefined;
		request: ProviderProtocolRequest;
	}>;
	anthropic: Readonly<{
		maxOutputTokens: number | undefined;
		model: ProviderModel;
		providerOptions: AnthropicProtocolOptions | undefined;
		request: ProviderProtocolRequest;
	}>;
	google: Readonly<{
		maxOutputTokens: number | undefined;
		providerOptions: GoogleProtocolOptions | undefined;
		request: ProviderProtocolRequest;
	}>;
	"openai-chat": Readonly<{
		maxOutputTokens: number | undefined;
		model: ProviderModel;
		request: ProviderProtocolRequest;
	}>;
};

export type ModelProtocol = keyof ProviderProtocolRequestContextByProtocol;

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
		model: ProviderModel
	) => ModelProtocolPromptCacheRoute | undefined;
}>;

export type ModelProtocolStrategyFor<P extends ModelProtocol> = Readonly<{
	protocol: P;
	promptCache: ModelProtocolPromptCacheStrategy;
	serialize: (
		context: ProviderProtocolRequestContextByProtocol[P]
	) => Record<string, unknown>;
	stream: (
		response: Response,
		signal?: AbortSignal
	) => AsyncIterable<ProtocolStreamPart>;
}>;

export type ModelProtocolStrategy<P extends ModelProtocol = ModelProtocol> = {
	[Protocol in P]: ModelProtocolStrategyFor<Protocol>;
}[P];
