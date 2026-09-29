import type { ModelProviderOptions } from "../../model-provider-options";
import type { ConnectionProviderId, SupportedChatModel } from "../../models";
import type {
	ModelProtocol,
	ModelProtocolStrategy,
	ModelProtocolStrategyFor,
	ProtocolRequestContextByProtocol,
} from "../protocols/types";
import type { ModelStepRequest } from "../types";

export type ProviderProtocolById = {
	openai: "openai-responses";
	anthropic: "anthropic";
	google: "google";
	"opencode-go": Exclude<ModelProtocol, "google">;
};

export type ProviderRequestContext = Readonly<{
	maxOutputTokens: number | undefined;
	model: SupportedChatModel;
	providerOptions: ModelProviderOptions | undefined;
	request: ModelStepRequest;
}>;

export type ProviderRouteFor<P extends ModelProtocol> = Readonly<{
	body: Record<string, unknown>;
	headers: RequestInit["headers"];
	strategy: ModelProtocolStrategyFor<P>;
	url: string;
}>;

export type ProviderRoute<P extends ModelProtocol = ModelProtocol> = {
	[Protocol in P]: ProviderRouteFor<Protocol>;
}[P];

export type ConnectionProviderAdapter<
	P extends ConnectionProviderId = ConnectionProviderId,
> = Readonly<{
	defaultStrategy: ModelProtocolStrategy<ProviderProtocolById[P]>;
	createRequest: (
		context: ProviderRequestContext
	) => ProviderRoute<ProviderProtocolById[P]>;
}>;

export const providerRouteFor = <P extends ModelProtocol>(
	strategy: ModelProtocolStrategyFor<P>,
	url: string,
	headers: RequestInit["headers"],
	bodyContext: ProtocolRequestContextByProtocol[NoInfer<P>]
): ProviderRouteFor<P> => ({
	body: strategy.serialize(bodyContext),
	headers,
	strategy,
	url,
});
