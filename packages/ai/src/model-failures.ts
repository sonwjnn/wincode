import { z } from "zod";
import {
	type ConnectionProviderId,
	connectionProviderIdSchema,
} from "./models";
export const MODEL_FAILURE_VERSION = 1 as const;

export const modelFailureCodes = [
	"authentication",
	"authorization",
	"cancelled",
	"context-overflow",
	"deadline-exceeded",
	"invalid-request",
	"network",
	"rate-limited",
	"unavailable",
	"unknown",
] as const;
export type ModelFailureCode = (typeof modelFailureCodes)[number];

export const modelFailureSources = [
	"provider",
	"transport",
	"runtime",
] as const;
export type ModelFailureSource = (typeof modelFailureSources)[number];

export const modelFailureRetryDispositions = [
	"never",
	"immediate",
	"after-delay",
	"with-changes",
] as const;
export type ModelFailureRetryDisposition =
	(typeof modelFailureRetryDispositions)[number];

export type ModelFailureDetails = {
	readonly modelId?: string;
	readonly providerId?: ConnectionProviderId;
	readonly retryAfterMs?: number;
	readonly statusCode?: number;
};
export type ModelFailureContext = Pick<
	ModelFailureDetails,
	"modelId" | "providerId"
>;

export type ModelFailure = {
	readonly code: ModelFailureCode;
	readonly details?: ModelFailureDetails;
	readonly message: string;
	readonly retry: ModelFailureRetryDisposition;
	readonly source: ModelFailureSource;
	readonly version: typeof MODEL_FAILURE_VERSION;
};
const modelFailureDetailsSchema = z
	.object({
		modelId: z.string().min(1).optional(),
		providerId: connectionProviderIdSchema.optional(),
		retryAfterMs: z.number().int().positive().optional(),
		statusCode: z.number().int().min(100).max(599).optional(),
	})
	.strict();

export const modelFailureSchema = z
	.object({
		code: z.enum(modelFailureCodes),
		details: modelFailureDetailsSchema.optional(),
		message: z.string().min(1),
		retry: z.enum(modelFailureRetryDispositions),
		source: z.enum(modelFailureSources),
		version: z.literal(MODEL_FAILURE_VERSION),
	})
	.strict();

const CONTEXT_OVERFLOW_PATTERN =
	/(context[_ -]?(?:length|limit|window|size)|(?:maximum|max)[^\n]{0,48}(?:context|tokens?)|(?:prompt|input)[^\n]{0,32}(?:too large|too long|exceed)|too many tokens|token limit exceeded|request too large)/iu;
const AUTHENTICATION_PATTERN =
	/(?:(?:invalid|missing|expired|revoked|incorrect)[^\n]{0,32}(?:api[_ -]?key|token|credential)|authentication|unauthenticated|401\b)/iu;
const AUTHORIZATION_PATTERN =
	/(?:forbidden|not authorized|permission denied|access denied|403\b)/iu;
const RATE_LIMIT_PATTERN =
	/(?:rate[_ -]?limit|too many requests|quota exceeded|429\b)/iu;
const INVALID_REQUEST_PATTERN =
	/(?:invalid request|bad request|malformed request|unsupported parameter|400\b)/iu;
const NETWORK_PATTERN =
	/(?:network|fetch|connection|socket|dns|econn|enotfound|offline)/iu;
const DEADLINE_PATTERN = /(?:deadline|timed? ?out|timeout)/iu;
const CANCEL_PATTERN = /(?:abort|cancel|cancelled|canceled)/iu;

const safeMessageByCode: Record<ModelFailureCode, string> = {
	authentication: "Model authentication failed.",
	authorization: "Model authorization was denied.",
	cancelled: "Model request was cancelled.",
	"context-overflow": "The model context is too large.",
	"deadline-exceeded": "The model request exceeded its deadline.",
	"invalid-request": "The model rejected the request.",
	network: "The model connection failed.",
	"rate-limited": "The model provider rate-limited the request.",
	unavailable: "The model provider is unavailable.",
	unknown: "The model request failed.",
};

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

const getProperty = (value: unknown, key: string): unknown =>
	typeof value === "object" && value !== null && key in value
		? value[key as keyof typeof value]
		: undefined;

const getStatusCode = (chain: readonly unknown[]): number | undefined => {
	for (const value of chain) {
		const status =
			getProperty(value, "statusCode") ?? getProperty(value, "status");
		if (
			typeof status === "number" &&
			Number.isInteger(status) &&
			status >= 100 &&
			status <= 599
		) {
			return status;
		}
	}
};

const getRetryAfterMs = (chain: readonly unknown[]): number | undefined => {
	for (const value of chain) {
		const retryAfterMs = getProperty(value, "retryAfterMs");
		if (
			typeof retryAfterMs === "number" &&
			Number.isInteger(retryAfterMs) &&
			retryAfterMs > 0
		) {
			return retryAfterMs;
		}
	}
};

const getDiagnosticText = (value: unknown): string => {
	if (value instanceof Error) {
		return value.message;
	}
	const message = getProperty(value, "message");
	if (typeof message === "string") {
		return message;
	}
	const responseBody = getProperty(value, "responseBody");
	return typeof responseBody === "string" ? responseBody : "";
};

const getCombinedDiagnosticText = (chain: readonly unknown[]): string =>
	chain.map(getDiagnosticText).filter(Boolean).join("\n");

const getFailureCode = (
	chain: readonly unknown[],
	text: string,
	statusCode: number | undefined
): ModelFailureCode => {
	if (statusCode === 401 || AUTHENTICATION_PATTERN.test(text)) {
		return "authentication";
	}
	if (statusCode === 403 || AUTHORIZATION_PATTERN.test(text)) {
		return "authorization";
	}
	if (CONTEXT_OVERFLOW_PATTERN.test(text)) {
		return "context-overflow";
	}
	if (statusCode === 429 || RATE_LIMIT_PATTERN.test(text)) {
		return "rate-limited";
	}
	if (
		chain.some(
			(value) =>
				value instanceof Error &&
				(value.name === "TimeoutError" ||
					value.name === "DeadlineExceededError")
		) ||
		DEADLINE_PATTERN.test(text)
	) {
		return "deadline-exceeded";
	}
	if (
		chain.some(
			(value) => value instanceof Error && value.name === "AbortError"
		) ||
		CANCEL_PATTERN.test(text)
	) {
		return "cancelled";
	}
	if (statusCode === 400 || INVALID_REQUEST_PATTERN.test(text)) {
		return "invalid-request";
	}
	if (statusCode !== undefined && statusCode >= 500) {
		return "unavailable";
	}
	if (NETWORK_PATTERN.test(text)) {
		return "network";
	}
	return "unknown";
};

const getSource = (
	code: ModelFailureCode,
	statusCode: number | undefined
): ModelFailureSource => {
	if (
		code === "cancelled" ||
		code === "deadline-exceeded" ||
		code === "network"
	) {
		return "transport";
	}
	if (statusCode !== undefined || code !== "unknown") {
		return "provider";
	}
	return "runtime";
};

const getRetryDisposition = (
	code: ModelFailureCode
): ModelFailureRetryDisposition => {
	switch (code) {
		case "context-overflow":
			return "with-changes";
		case "network":
		case "rate-limited":
		case "unavailable":
			return "after-delay";
		default:
			return "never";
	}
};

const buildDetails = (
	context: ModelFailureContext | undefined,
	statusCode: number | undefined,
	retryAfterMs: number | undefined
): ModelFailureDetails | undefined => {
	const details = {
		...(context?.modelId === undefined ? {} : { modelId: context.modelId }),
		...(context?.providerId === undefined
			? {}
			: { providerId: context.providerId }),
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
		...(statusCode === undefined ? {} : { statusCode }),
	};
	return Object.keys(details).length === 0 ? undefined : details;
};

/** Normalize an expected model failure to a safe, versioned public value. */
export const normalizeModelFailure = (
	error: unknown,
	context?: ModelFailureContext
): ModelFailure => {
	const existing = modelFailureSchema.safeParse(error);
	if (existing.success) {
		return { ...existing.data, message: safeMessageByCode[existing.data.code] };
	}
	const chain = getErrorChain(error);
	const statusCode = getStatusCode(chain);
	const retryAfterMs = getRetryAfterMs(chain);
	const text = getCombinedDiagnosticText(chain);
	const code = getFailureCode(chain, text, statusCode);
	const details = buildDetails(context, statusCode, retryAfterMs);
	return {
		code,
		...(details === undefined ? {} : { details }),
		message: safeMessageByCode[code],
		retry: getRetryDisposition(code),
		source: getSource(code, statusCode),
		version: MODEL_FAILURE_VERSION,
	};
};

export const getModelFailureMessage = (
	error: unknown,
	context?: ModelFailureContext
): string => normalizeModelFailure(error, context).message;

export const isModelContextOverflowError = (error: unknown): boolean =>
	normalizeModelFailure(error).code === "context-overflow";
