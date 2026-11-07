import type {
	ModelRetryPolicy,
	ModelStepAttemptSummary,
} from "@wincode/agent-core";
import { logger } from "@wincode/utils";
import { z } from "zod";
import type { ConfigRuntime } from "@/shared/config/config-store";

export const DEFAULT_MODEL_RETRY_POLICY: Omit<ModelRetryPolicy, "onStatus"> = {
	baseDelayMs: 2000,
	maxDelayMs: 60_000,
	maxRetries: 3,
};

export const modelRetryPolicySettingsSchema = z
	.object({
		baseDelayMs: z.number().int().min(0).max(60_000).optional(),
		enabled: z.boolean().optional(),
		maxDelayMs: z.number().int().min(0).max(60_000).optional(),
		maxRetries: z.number().int().min(0).max(10).optional(),
	})
	.strict();

const disabledPolicy = (): Omit<ModelRetryPolicy, "onStatus"> => ({
	...DEFAULT_MODEL_RETRY_POLICY,
	maxRetries: 0,
});

/** Invalid retry settings fail closed so malformed config cannot expand retries. */
export const resolveConfiguredModelRetryPolicy = (
	settings: unknown
): Omit<ModelRetryPolicy, "onStatus"> => {
	if (settings === undefined) {
		return DEFAULT_MODEL_RETRY_POLICY;
	}
	const parsed = modelRetryPolicySettingsSchema.safeParse(settings);
	if (!parsed.success) {
		logger.warn(
			"Invalid modelRetry settings; automatic retries are disabled.",
			{
				fields: parsed.error.issues.map((issue) => issue.path.join(".")),
			}
		);
		return disabledPolicy();
	}
	const { enabled, ...configured } = parsed.data;
	const policy = { ...DEFAULT_MODEL_RETRY_POLICY, ...configured };
	if (policy.baseDelayMs > policy.maxDelayMs) {
		logger.warn(
			"Invalid modelRetry delay range; automatic retries are disabled.",
			{
				baseDelayMs: policy.baseDelayMs,
				maxDelayMs: policy.maxDelayMs,
			}
		);
		return disabledPolicy();
	}
	return {
		...policy,
		maxRetries: enabled === false ? 0 : policy.maxRetries,
	};
};

export const formatModelRetryFailureText = (
	message: string,
	attempts: readonly ModelStepAttemptSummary[] | undefined,
	truncated = false
): string => {
	const retryCount =
		attempts?.filter((attempt) => attempt.retryDecision === "scheduled")
			.length ?? 0;
	if (retryCount === 0) {
		return message;
	}
	const count = truncated ? `at least ${retryCount}` : String(retryCount);
	return `${message} Automatic recovery stopped after ${count} ${retryCount === 1 ? "retry" : "retries"}.`;
};

export const resolveSessionModelRetryPolicy = async (
	configRuntime: ConfigRuntime
): Promise<Omit<ModelRetryPolicy, "onStatus">> => {
	const snapshot = await configRuntime.configStore
		.getSnapshot(configRuntime.workspace)
		.catch(() => undefined);
	return resolveConfiguredModelRetryPolicy(snapshot?.document.modelRetry);
};
