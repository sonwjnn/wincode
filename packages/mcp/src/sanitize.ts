import { getErrorMessage, isUndefined, sanitizeText } from "@wincode/utils";
import type { ResolvedMcpServerConfig } from "./config";

const MAX_SANITIZED_MESSAGE_LENGTH = 2048;

export const collectSecrets = (
	config: ResolvedMcpServerConfig
): readonly string[] => {
	if (config.type === "remote") {
		return [...Object.values(config.headers ?? {}), config.url];
	}
	return [
		...config.command.slice(1),
		...Object.values(config.environment ?? {}),
	];
};

export const sanitizeMessage = (
	config: ResolvedMcpServerConfig | undefined,
	error: unknown,
	fallback: string
): string => {
	const message = getErrorMessage(error, fallback);
	if (isUndefined(config)) {
		return fallback;
	}
	return sanitizeText(message, {
		maxChars: MAX_SANITIZED_MESSAGE_LENGTH,
		redactUrls: true,
		secrets: collectSecrets(config),
	});
};
