export const SESSION_LOG_IDENTIFIER_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9._-]*(?![\s\S])/u;

export const isValidSessionLogIdentifier = (value: string): boolean =>
	value.length <= 512 && SESSION_LOG_IDENTIFIER_PATTERN.test(value);
