import { expect, test } from "bun:test";
import {
	DEFAULT_MODEL_RETRY_POLICY,
	resolveConfiguredModelRetryPolicy,
} from "../../modules/sessions/retry-policy";

test("missing modelRetry settings use the bounded default policy", () => {
	expect(resolveConfiguredModelRetryPolicy(undefined)).toEqual(
		DEFAULT_MODEL_RETRY_POLICY
	);
});

test("modelRetry can disable retries or override each delay and attempt bound", () => {
	expect(
		resolveConfiguredModelRetryPolicy({
			baseDelayMs: 250,
			enabled: false,
			maxDelayMs: 1000,
			maxRetries: 5,
		})
	).toEqual({ baseDelayMs: 250, maxDelayMs: 1000, maxRetries: 0 });
	expect(
		resolveConfiguredModelRetryPolicy({
			baseDelayMs: 500,
			maxDelayMs: 5000,
			maxRetries: 2,
		})
	).toEqual({ baseDelayMs: 500, maxDelayMs: 5000, maxRetries: 2 });
});

test("invalid modelRetry settings fail closed instead of using active defaults", () => {
	for (const settings of [
		{ maxRetries: 11 },
		{ baseDelayMs: 2000, maxDelayMs: 1000 },
		{ unexpected: true },
	]) {
		expect(resolveConfiguredModelRetryPolicy(settings)).toEqual({
			...DEFAULT_MODEL_RETRY_POLICY,
			maxRetries: 0,
		});
	}
});
