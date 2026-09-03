export const OPERATIONAL_FAILURE_VERSION = 1 as const;

/**
 * Stable failure families for expected Agent Turn failures. Model-sourced
 * codes mirror the normalized model failure codes from `@wincode/ai` so
 * adapter mapping is lossless; runtime-sourced codes cover the turn loop.
 * Cancellation and interruption arrive as terminal statuses with the
 * operational failure ticket.
 */
export const operationalFailureCodes = [
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

/**
 * Expected failure of one Agent Turn, represented as a safe, versioned value.
 * Messages are presentation-safe; details are allowlisted; raw causes,
 * credentials, prompts, headers, and provider bodies never enter this shape.
 */
export type OperationalFailure = {
	readonly code: OperationalFailureCode;
	readonly details?: {
		readonly modelId?: string;
		readonly providerId?: string;
		readonly retryAfterMs?: number;
	};
	readonly message: string;
	readonly retry: OperationalFailureRetryDisposition;
	readonly source: OperationalFailureSource;
	readonly version: typeof OPERATIONAL_FAILURE_VERSION;
};

export const isOperationalFailureSource = (
	value: unknown
): value is OperationalFailureSource =>
	typeof value === "string" &&
	(operationalFailureSources as readonly string[]).includes(value);
