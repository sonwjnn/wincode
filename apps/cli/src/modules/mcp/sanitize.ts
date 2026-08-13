import type { ResolvedMcpServerConfig } from "./config";

const MAX_SANITIZED_MESSAGE_LENGTH = 2048;
const GENERIC_SECRET_REGEX =
	/\b(?:(?:api[ _-]?key|auth(?:orization)?|cookie|credential|password|private[ _-]?key|secret|session|token)\s*[:=]\s*(?:bearer\s+)?[^\s,;}\]]+|bearer\s+[^\s,;}\]]+)/gi;

const stripControlCharacters = (value: string): string =>
	Array.from(value, (character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || (code >= 127 && code <= 159) ? " " : character;
	}).join("");

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
	const message = error instanceof Error ? error.message : fallback;
	if (config === undefined) {
		return fallback;
	}
	const redacted = collectSecrets(config).reduce(
		(acc, secret) =>
			secret.length > 0 ? acc.split(secret).join("[redacted]") : acc,
		message
	);
	return stripControlCharacters(redacted)
		.replace(GENERIC_SECRET_REGEX, "[redacted]")
		.slice(0, MAX_SANITIZED_MESSAGE_LENGTH);
};
