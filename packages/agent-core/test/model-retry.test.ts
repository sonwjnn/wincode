import { expect, test } from "bun:test";
import {
	createOperationalFailure,
	type ModelRetryPolicy,
	resolveModelRetryDelay,
} from "../src/index";

const policy: ModelRetryPolicy = {
	baseDelayMs: 2000,
	maxDelayMs: 60_000,
	maxRetries: 3,
};

test("Retry-After controls retry timing but cannot exceed the configured ceiling", () => {
	const rateLimited = createOperationalFailure({
		code: "rate-limited",
		details: { retryAfterMs: 8500 },
		retry: "after-delay",
		source: "model",
	});
	expect(resolveModelRetryDelay(rateLimited, 0, policy)).toEqual({
		delayMs: 8500,
		kind: "retry",
	});

	const excessive = createOperationalFailure({
		code: "rate-limited",
		details: { retryAfterMs: 60_001 },
		retry: "after-delay",
		source: "model",
	});
	expect(resolveModelRetryDelay(excessive, 0, policy)).toEqual({
		kind: "retry-delay-exceeds-limit",
		retryAfterMs: 60_001,
	});
});
