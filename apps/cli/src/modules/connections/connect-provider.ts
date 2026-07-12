import type {
	ConnectProviderOptions,
	ValidationFetch,
	WincodeCredentialValidator,
} from "./service";
import type { ConnectionsBackend } from "./storage";
import type {
	AnthropicCredential,
	OpenAICredential,
	ProviderId,
	WincodeCredential,
} from "./types";

const OPENAI_KEY_URL = "https://api.openai.com/v1/models";
const ANTHROPIC_KEY_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";

export const connectProvider = async (
	backend: ConnectionsBackend,
	providerId: ProviderId,
	credential: OpenAICredential | AnthropicCredential | WincodeCredential,
	options: ConnectProviderOptions = {}
): Promise<void> => {
	if (providerId === "openai") {
		await validateOpenAIKey(credential, options.fetch);
		await backend.replaceValidated(providerId, credential);
		return;
	}

	if (providerId === "anthropic") {
		await validateAnthropicKey(credential, options.fetch);
		await backend.replaceValidated(providerId, credential);
		return;
	}

	await validateWincodeCredential(credential, options.wincodeValidate);
	await backend.replaceValidated(providerId, credential);
};

const validateOpenAIKey = async (
	credential: OpenAICredential | AnthropicCredential | WincodeCredential,
	fetchImpl?: ValidationFetch
): Promise<void> => {
	if (!isApiKeyCredential(credential)) {
		throw new Error("OpenAI validation requires an API key credential.");
	}
	const fetchFn = fetchImpl ?? globalThis.fetch.bind(globalThis);
	const response = await fetchFn(OPENAI_KEY_URL, {
		headers: { Authorization: `Bearer ${credential.apiKey}` },
		method: "GET",
	});
	if (!response.ok) {
		throw new Error("OpenAI API key validation failed.");
	}
};

const validateAnthropicKey = async (
	credential: AnthropicCredential | OpenAICredential | WincodeCredential,
	fetchImpl?: ValidationFetch
): Promise<void> => {
	if (!isApiKeyCredential(credential)) {
		throw new Error("Anthropic validation requires an API key credential.");
	}
	const fetchFn = fetchImpl ?? globalThis.fetch.bind(globalThis);
	const response = await fetchFn(ANTHROPIC_KEY_URL, {
		headers: {
			"anthropic-version": ANTHROPIC_VERSION,
			"x-api-key": credential.apiKey,
		},
		method: "GET",
	});
	if (!response.ok) {
		throw new Error("Anthropic API key validation failed.");
	}
};

const validateWincodeCredential = async (
	credential: WincodeCredential | OpenAICredential | AnthropicCredential,
	validate?: WincodeCredentialValidator
): Promise<void> => {
	if (credential.kind !== "api-key") {
		return;
	}
	if (validate === undefined) {
		throw new Error(
			"Wincode API key validation unavailable until hosted validation API exists."
		);
	}
	await validate(credential as WincodeCredential);
};

const isApiKeyCredential = (
	credential: unknown
): credential is { apiKey: string } =>
	typeof credential === "object" &&
	credential !== null &&
	"apiKey" in credential;
