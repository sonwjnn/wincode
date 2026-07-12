import type { ConnectionsBackend } from "./storage";
import type {
	AnthropicCredential,
	OpenAICredential,
	ProviderId,
	WincodeCredential,
} from "./types";

export type ValidationFetch = (
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1]
) => Promise<Response>;

export type WincodeCredentialValidator = (
	credential: WincodeCredential
) => Promise<void>;

export type ConnectProviderOptions = {
	fetch?: ValidationFetch;
	wincodeValidate?: WincodeCredentialValidator;
};

export type ConnectWincodeBrowserOptions = {
	backend: ConnectionsBackend;
	onAuthorizationUrl?: (authorizationUrl: URL) => void;
	onStatus?: (status: WincodeBrowserStatus) => void;
};

export type WincodeBrowserStatus =
	| "starting"
	| "opening-browser"
	| "waiting-for-callback"
	| "exchanging-token"
	| "connected";

export type LegacyWincodeSessionReader = () => Promise<Omit<
	WincodeCredential,
	"kind"
> | null>;

export type LegacyMigration = {
	readLegacyWincodeSession: LegacyWincodeSessionReader;
	backend?: ConnectionsBackend;
};

export type ProviderCredentialInput =
	| OpenAICredential
	| AnthropicCredential
	| WincodeCredential;

export type ConnectionService = {
	connect(
		providerId: ProviderId,
		credential: ProviderCredentialInput,
		options?: ConnectProviderOptions
	): Promise<void>;
	connectWincodeBrowser(options: ConnectWincodeBrowserOptions): Promise<void>;
	migrateLegacyWincodeSession(options: LegacyMigration): Promise<boolean>;
};
