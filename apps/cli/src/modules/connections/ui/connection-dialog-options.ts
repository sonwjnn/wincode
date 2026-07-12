import type { ProviderId } from "../types";

export type ConnectionMethodId = "browser" | "api-key";

export type ConnectionProviderOption = {
	id: ProviderId;
	label: string;
	details: string;
	methods: readonly ConnectionMethodId[];
};

export type ConnectionMethodOption = {
	id: ConnectionMethodId;
	label: string;
	details: string;
};

export const CONNECTION_PROVIDERS: readonly ConnectionProviderOption[] = [
	{
		id: "wincode",
		label: "Wincode",
		details: "Browser sign-in or API key",
		methods: ["browser", "api-key"],
	},
	{
		id: "openai",
		label: "OpenAI",
		details: "Browser sign-in or API key",
		methods: ["browser", "api-key"],
	},
	{
		id: "anthropic",
		label: "Anthropic",
		details: "API key only",
		methods: ["api-key"],
	},
] as const;

const CONNECTION_METHODS: readonly ConnectionMethodOption[] = [
	{
		id: "browser",
		label: "Browser sign-in",
		details: "Open a browser and copy the URL.",
	},
	{
		id: "api-key",
		label: "API key",
		details: "Paste a key directly into the terminal.",
	},
] as const;

function getMaxLabelWidth(labels: readonly string[]): number {
	return labels.reduce(
		(maxWidth, label) => Math.max(maxWidth, label.length),
		0
	);
}

export const CONNECTION_LABEL_COLUMN_WIDTH =
	Math.max(
		getMaxLabelWidth(CONNECTION_PROVIDERS.map((provider) => provider.label)),
		getMaxLabelWidth(CONNECTION_METHODS.map((method) => method.label))
	) + 2;

export function getConnectionProviderOption(
	providerId: ProviderId
): ConnectionProviderOption {
	const provider = CONNECTION_PROVIDERS.find((item) => item.id === providerId);
	if (!provider) {
		throw new Error(`Unknown connection provider: ${providerId}`);
	}

	return provider;
}

export function getConnectionMethodOptions(
	providerId: ProviderId
): readonly ConnectionMethodOption[] {
	const provider = getConnectionProviderOption(providerId);
	return CONNECTION_METHODS.filter((method) =>
		provider.methods.includes(method.id)
	);
}
