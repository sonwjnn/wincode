import type { ConnectionProviderId } from "@wincode/ai";
import type {
	AuthorizationByProvider,
	CredentialByProvider,
	ProviderAdapterMap as RegistryAdapterMap,
	ConnectRequest as RegistryConnectRequest,
	ConnectRequestFor as RegistryConnectRequestFor,
} from "./provider-registry";
import { providerDisplayNames } from "./provider-registry";

export type {
	AcquisitionProgress,
	ApiKeyCredential,
	ConnectionProgress,
	OpenAICredential,
	WincodeCredential,
} from "./credential-schemas";
export type {
	AuthorizationByProvider,
	CredentialByProvider,
} from "./provider-registry";
export { credentialSchemas } from "./provider-registry";

export const connectionProviderDisplayNames = providerDisplayNames;
export type { ProviderMethod } from "./provider-definition";
export type ConnectionProviderSummary =
	import("./provider-definition").ProviderSummary;
export type Credential = CredentialByProvider[keyof CredentialByProvider];
export type ConnectionAuthorization =
	AuthorizationByProvider[ConnectionProviderId];
export type ConnectRequest = RegistryConnectRequest;
export type ConnectRequestFor<P extends ConnectionProviderId> =
	RegistryConnectRequestFor<P>;
export type ProviderAdapter<P extends ConnectionProviderId> =
	RegistryAdapterMap[P];
export type ProviderAdapterMap = RegistryAdapterMap;
export type BrowserCapableConnectionProviderId = Extract<
	ConnectionProviderId,
	"openai" | "wincode"
>;
export const isBrowserCapableProvider = (
	provider: Pick<ConnectionProviderSummary, "id" | "methods">
): provider is Pick<ConnectionProviderSummary, "methods"> & {
	id: BrowserCapableConnectionProviderId;
} => provider.methods.includes("browser");

export type Connections = {
	listProviders(): Promise<readonly ConnectionProviderSummary[]>;
	connect(request: ConnectRequest): Promise<void>;
	authorize<P extends ConnectionProviderId>(
		providerId: P,
		signal?: AbortSignal
	): Promise<AuthorizationByProvider[P]>;
};
