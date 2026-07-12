// biome-ignore lint/performance/noBarrelFile: module public API for cross-module access.
export { connectProvider } from "./connect-provider";
export {
	type ConnectWincodeBrowserOptions,
	connectWincodeBrowser,
	createAuthorizationUrl,
	getWincodeBrowserConfig,
	isLoopbackHttpIssuer,
	type WincodeBrowserStatus,
} from "./connect-wincode-browser";
export { getHostedBearer, validateWincodeApiKey } from "./hosted-auth";
export { readLegacyWincodeSession } from "./legacy-reader";
export { migrateLegacyWincodeSession } from "./migrate-legacy";
export {
	connectOpenAIBrowser,
	type OpenAIBrowserConnectOptions,
	refreshOpenAICredential,
} from "./openai-browser-oauth";
export type {
	ConnectionService,
	ConnectProviderOptions,
	LegacyMigration,
	ValidationFetch,
	WincodeCredentialValidator,
} from "./service";
export {
	type ConnectionsBackend,
	type ConnectionsStorageOptions,
	createConnectionsStore,
	type SecretStore,
	validateCredential,
} from "./storage";
export {
	type AnthropicCredential,
	type ConnectionStatus,
	type Credential,
	type CredentialByProvider,
	type LegacyWincodeSession,
	type OpenAICredential,
	type ProviderId,
	providerIds,
	type WincodeCredential,
} from "./types";
export {
	CONNECTION_DIALOG_WIDTH,
	ConnectDialogContent,
} from "./ui/connect-dialog";
export { ConnectionApiKeyDialogContent } from "./ui/connection-api-key-dialog";
export { ConnectionBrowserWaitingDialogContent } from "./ui/connection-browser-waiting-dialog";
export {
	CONNECTION_PROVIDERS,
	type ConnectionMethodId,
	type ConnectionMethodOption,
	type ConnectionProviderOption,
	getConnectionMethodOptions,
	getConnectionProviderOption,
} from "./ui/connection-dialog-options";
export { ConnectionMethodPickerDialogContent } from "./ui/connection-method-picker-dialog";
export { ConnectionProviderPickerDialogContent } from "./ui/connection-provider-picker-dialog";
