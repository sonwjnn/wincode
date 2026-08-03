import type { ResolvedMcpServerConfig } from "./config";

export const collectSecrets = (
	config: ResolvedMcpServerConfig
): readonly string[] => {
	if (config.type === "remote") {
		return [...Object.values(config.headers ?? {}), config.url];
	}
	return Object.values(config.environment ?? {});
};

export const sanitizeMessage = (
	config: ResolvedMcpServerConfig | undefined,
	error: unknown,
	fallback: string
): string => {
	const message = error instanceof Error ? error.message : fallback;
	if (config === undefined) {
		return message;
	}
	return collectSecrets(config).reduce(
		(acc, secret) =>
			secret.length > 0 ? acc.split(secret).join("[redacted]") : acc,
		message
	);
};
