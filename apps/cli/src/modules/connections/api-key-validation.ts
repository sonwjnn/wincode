export type ValidationFetch = (
	input: string | URL | Request,
	init?: RequestInit
) => Promise<Response>;

const OPENAI_KEY_URL = "https://api.openai.com/v1/models";
const ANTHROPIC_KEY_URL = "https://api.anthropic.com/v1/models";
const GOOGLE_KEY_URL =
	"https://generativelanguage.googleapis.com/v1beta/models";
const ANTHROPIC_VERSION = "2023-06-01";

export type ApiKeyCredential = { kind: "api-key"; apiKey: string };

export const validateOpenAIKey = async (
	credential: ApiKeyCredential,
	fetchImpl?: ValidationFetch
): Promise<void> => {
	const response = await (fetchImpl ?? globalThis.fetch.bind(globalThis))(
		OPENAI_KEY_URL,
		{ headers: { Authorization: `Bearer ${credential.apiKey}` }, method: "GET" }
	);
	if (!response.ok) {
		throw new Error("OpenAI API key validation failed.");
	}
};

export const validateAnthropicKey = async (
	credential: ApiKeyCredential,
	fetchImpl?: ValidationFetch
): Promise<void> => {
	const response = await (fetchImpl ?? globalThis.fetch.bind(globalThis))(
		ANTHROPIC_KEY_URL,
		{
			headers: {
				"anthropic-version": ANTHROPIC_VERSION,
				"x-api-key": credential.apiKey,
			},
			method: "GET",
		}
	);
	if (!response.ok) {
		throw new Error("Anthropic API key validation failed.");
	}
};

export const validateGoogleKey = async (
	credential: ApiKeyCredential,
	fetchImpl?: ValidationFetch
): Promise<void> => {
	const response = await (fetchImpl ?? globalThis.fetch.bind(globalThis))(
		GOOGLE_KEY_URL,
		{ headers: { "x-goog-api-key": credential.apiKey }, method: "GET" }
	);
	if (!response.ok) {
		throw new Error("Google API key validation failed.");
	}
};
