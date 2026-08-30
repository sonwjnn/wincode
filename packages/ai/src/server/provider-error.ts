import { getProviderErrorMessage } from "./error-message";

export type ProviderErrorKind = "context-overflow" | "other";

const CONTEXT_OVERFLOW_PATTERN =
	/(context[_ -]?(?:length|limit|window|size)|(?:maximum|max)[^\n]{0,48}(?:context|tokens?)|(?:prompt|input)[^\n]{0,32}(?:too large|too long|exceed)|too many tokens|token limit exceeded|request too large)/iu;

const getErrorChain = (error: unknown): unknown[] => {
	const chain: unknown[] = [];
	const visited = new Set<unknown>();
	let current: unknown = error;
	while (current !== null && current !== undefined && !visited.has(current)) {
		visited.add(current);
		chain.push(current);
		if (typeof current !== "object" || !("cause" in current)) {
			break;
		}
		current = current.cause;
	}
	return chain;
};

const getResponseBody = (value: unknown): string | undefined => {
	if (
		typeof value !== "object" ||
		value === null ||
		!("responseBody" in value)
	) {
		return;
	}
	return typeof value.responseBody === "string"
		? value.responseBody
		: undefined;
};

export const isContextOverflowError = (error: unknown): boolean => {
	for (const value of getErrorChain(error)) {
		const message = value instanceof Error ? value.message : undefined;
		if (message && CONTEXT_OVERFLOW_PATTERN.test(message)) {
			return true;
		}
		const responseBody = getResponseBody(value);
		if (responseBody && CONTEXT_OVERFLOW_PATTERN.test(responseBody)) {
			return true;
		}
	}
	return CONTEXT_OVERFLOW_PATTERN.test(getProviderErrorMessage(error));
};

export const classifyProviderError = (error: unknown): ProviderErrorKind =>
	isContextOverflowError(error) ? "context-overflow" : "other";
