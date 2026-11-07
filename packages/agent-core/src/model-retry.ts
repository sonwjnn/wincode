import type { OperationalFailure } from "./failures";
import type { ModelRetryPolicy } from "./runtime";

export type ModelRetryDelayResolution =
	| Readonly<{ kind: "not-retryable" }>
	| Readonly<{ kind: "retry-delay-exceeds-limit"; retryAfterMs: number }>
	| Readonly<{ delayMs: number; kind: "retry" }>;

/** Resolves one retry's bounded backoff without changing the failure contract. */
export const resolveModelRetryDelay = (
	failure: OperationalFailure,
	retryIndex: number,
	policy: ModelRetryPolicy
): ModelRetryDelayResolution => {
	if (
		failure.source !== "model" ||
		(failure.retry !== "after-delay" && failure.retry !== "immediate")
	) {
		return { kind: "not-retryable" };
	}
	const retryAfterMs = failure.details?.retryAfterMs ?? 0;
	if (retryAfterMs > policy.maxDelayMs) {
		return { kind: "retry-delay-exceeds-limit", retryAfterMs };
	}
	return {
		delayMs: Math.max(
			Math.min(policy.baseDelayMs * 2 ** retryIndex, policy.maxDelayMs),
			retryAfterMs
		),
		kind: "retry",
	};
};
