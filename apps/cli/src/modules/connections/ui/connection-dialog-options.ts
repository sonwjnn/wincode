import type { ConnectionProviderSummary } from "../contract";

export type ConnectionMethodId = "browser" | "api-key";

export type ConnectionMethodOption = {
	id: ConnectionMethodId;
	label: string;
	details: string;
};

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
		getMaxLabelWidth(["Wincode", "OpenAI", "Anthropic", "Google"]),
		getMaxLabelWidth(CONNECTION_METHODS.map((method) => method.label))
	) + 2;

export function getConnectionMethodOptions(
	provider: ConnectionProviderSummary
): readonly ConnectionMethodOption[] {
	return CONNECTION_METHODS.filter((method) =>
		provider.methods.includes(method.id)
	);
}

export function getConnectionProviderDetails(
	provider: ConnectionProviderSummary
): string {
	if (provider.methods.length === 2) {
		return "Browser sign-in or API key";
	}

	return "API key only";
}
