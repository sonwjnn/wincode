import {
	isNonEmptyString,
	isObjectLike,
	isString,
	isUndefined,
} from "@wincode/runtime-utils";
import type { UnknownRecord } from "type-fest";
export const OPERATIONAL_FAILURE_VERSION = 1 as const;

/**
 * Stable failure families for expected Agent Turn failures. Model-sourced
 * codes mirror the normalized model failure codes from `@wincode/ai`; runtime
 * codes cover turn control and adapter-owned failures.
 */
export const operationalFailureCodes = [
	"authentication",
	"authorization",
	"cancelled",
	"context-overflow",
	"deadline-exceeded",
	"interrupted",
	"invalid-request",
	"network",
	"rate-limited",
	"unavailable",
	"unknown",
] as const;
export type OperationalFailureCode = (typeof operationalFailureCodes)[number];

export const operationalFailureSources = ["model", "runtime"] as const;
export type OperationalFailureSource =
	(typeof operationalFailureSources)[number];

export const operationalFailureRetryDispositions = [
	"never",
	"immediate",
	"after-delay",
	"with-changes",
] as const;
export type OperationalFailureRetryDisposition =
	(typeof operationalFailureRetryDispositions)[number];

export type OperationalFailureDetails = Readonly<{
	modelId?: string;
	providerId?: string;
	retryAfterMs?: number;
	statusCode?: number;
}>;

/**
 * Expected failure of one Agent Turn, represented as a safe, versioned value.
 * Messages are presentation-safe; details are allowlisted; raw causes,
 * credentials, prompts, headers, and provider bodies never enter this shape.
 */
export type OperationalFailure = Readonly<{
	code: OperationalFailureCode;
	details?: OperationalFailureDetails;
	message: string;
	retry: OperationalFailureRetryDisposition;
	source: OperationalFailureSource;
	version: typeof OPERATIONAL_FAILURE_VERSION;
}>;

const safeMessageByCode: Record<OperationalFailureCode, string> = {
	authentication: "Model authentication failed.",
	authorization: "Model authorization was denied.",
	cancelled: "The Agent Turn was cancelled.",
	"context-overflow": "The model context is too large.",
	"deadline-exceeded": "The model request exceeded its deadline.",
	interrupted: "The Agent Turn was interrupted.",
	"invalid-request": "The model rejected the request.",
	network: "The model connection failed.",
	"rate-limited": "The model provider rate-limited the request.",
	unavailable: "The model provider is unavailable.",
	unknown: "The model request failed.",
};
const isOperationalFailureCode = (
	value: unknown
): value is OperationalFailureCode =>
	isString(value) &&
	(operationalFailureCodes as readonly string[]).includes(value);
const isOperationalFailureRetryDisposition = (
	value: unknown
): value is OperationalFailureRetryDisposition =>
	isString(value) &&
	(operationalFailureRetryDispositions as readonly string[]).includes(value);

const isAllowedDetails = (
	value: unknown
): value is OperationalFailureDetails => {
	if (isUndefined(value)) {
		return true;
	}
	if (!isObjectLike(value)) {
		return false;
	}
	const details = value as UnknownRecord;
	const allowedKeys = new Set([
		"modelId",
		"providerId",
		"retryAfterMs",
		"statusCode",
	]);
	if (Object.keys(details).some((key) => !allowedKeys.has(key))) {
		return false;
	}
	const hasInvalidModelId = !(
		isUndefined(details.modelId) || isNonEmptyString(details.modelId)
	);
	const hasInvalidProviderId = !(
		isUndefined(details.providerId) || isNonEmptyString(details.providerId)
	);
	const hasInvalidRetryAfterMs =
		!isUndefined(details.retryAfterMs) &&
		(typeof details.retryAfterMs !== "number" ||
			!Number.isInteger(details.retryAfterMs) ||
			details.retryAfterMs <= 0);
	const hasInvalidStatusCode =
		!isUndefined(details.statusCode) &&
		(typeof details.statusCode !== "number" ||
			!Number.isInteger(details.statusCode) ||
			details.statusCode < 100 ||
			details.statusCode > 599);
	if (
		hasInvalidModelId ||
		hasInvalidProviderId ||
		hasInvalidRetryAfterMs ||
		hasInvalidStatusCode
	) {
		return false;
	}
	return true;
};
const sanitizeOperationalFailureDetails = (
	value: OperationalFailureDetails | undefined
): OperationalFailureDetails | undefined => {
	if (!isAllowedDetails(value)) {
		return;
	}
	if (isUndefined(value)) {
		return;
	}
	return {
		...(isUndefined(value.modelId) ? {} : { modelId: value.modelId }),
		...(isUndefined(value.providerId) ? {} : { providerId: value.providerId }),
		...(isUndefined(value.retryAfterMs)
			? {}
			: { retryAfterMs: value.retryAfterMs }),
		...(isUndefined(value.statusCode) ? {} : { statusCode: value.statusCode }),
	};
};

export const isOperationalFailureSource = (
	value: unknown
): value is OperationalFailureSource =>
	isString(value) &&
	(operationalFailureSources as readonly string[]).includes(value);

export const isOperationalFailure = (
	value: unknown
): value is OperationalFailure => {
	if (!isObjectLike(value)) {
		return false;
	}
	const failure = value as UnknownRecord;
	if (
		Object.keys(failure).some(
			(key) =>
				!["code", "details", "message", "retry", "source", "version"].includes(
					key
				)
		)
	) {
		return false;
	}
	if (!isOperationalFailureCode(failure.code)) {
		return false;
	}
	return (
		isAllowedDetails(failure.details) &&
		failure.message === safeMessageByCode[failure.code] &&
		isOperationalFailureRetryDisposition(failure.retry) &&
		isOperationalFailureSource(failure.source) &&
		failure.version === OPERATIONAL_FAILURE_VERSION
	);
};

export type OperationalFailureContext = Readonly<{
	modelId?: string;
	providerId?: string;
}>;

const contextDetails = (
	context: OperationalFailureContext | undefined
): OperationalFailureDetails | undefined => {
	if (isUndefined(context?.modelId) && isUndefined(context?.providerId)) {
		return;
	}
	return {
		...(isUndefined(context.modelId) ? {} : { modelId: context.modelId }),
		...(isUndefined(context.providerId)
			? {}
			: { providerId: context.providerId }),
	};
};

/** Constructs a versioned failure using only the public safe fields. */
export const createOperationalFailure = ({
	code,
	details,
	retry,
	source,
}: {
	readonly code: OperationalFailureCode;
	readonly details?: OperationalFailureDetails;
	readonly retry: OperationalFailureRetryDisposition;
	readonly source: OperationalFailureSource;
}): OperationalFailure => {
	const safeDetails = sanitizeOperationalFailureDetails(details);
	return {
		code,
		...(isUndefined(safeDetails) ? {} : { details: safeDetails }),
		message: safeMessageByCode[code],
		retry,
		source,
		version: OPERATIONAL_FAILURE_VERSION,
	};
};
const normalizeFailureShape = (
	value: unknown
): OperationalFailure | undefined => {
	if (!isObjectLike(value)) {
		return;
	}
	const failure = value as UnknownRecord;
	if (
		!(
			isOperationalFailureCode(failure.code) &&
			isOperationalFailureRetryDisposition(failure.retry) &&
			isOperationalFailureSource(failure.source)
		)
	) {
		return;
	}
	const details = isAllowedDetails(failure.details)
		? sanitizeOperationalFailureDetails(failure.details)
		: undefined;
	return createOperationalFailure({
		code: failure.code,
		details,
		retry: failure.retry,
		source: failure.source,
	});
};

export const normalizeOperationalFailure = (
	value: unknown,
	context?: OperationalFailureContext
): OperationalFailure => {
	const normalized = normalizeFailureShape(value);
	if (!isUndefined(normalized)) {
		return normalized;
	}
	return createOperationalFailure({
		code: "unknown",
		details: contextDetails(context),
		retry: "never",
		source: "runtime",
	});
};

export const getOperationalFailureMessage = (
	code: OperationalFailureCode
): string => safeMessageByCode[code];
