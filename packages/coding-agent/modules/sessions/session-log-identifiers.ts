import { SESSION_IDENTIFIER_PATTERN } from "@/shared/identifiers";

export const SESSION_LOG_IDENTIFIER_PATTERN = SESSION_IDENTIFIER_PATTERN;

export const isValidSessionLogIdentifier = (value: string): boolean =>
	value.length <= 512 && SESSION_LOG_IDENTIFIER_PATTERN.test(value);
