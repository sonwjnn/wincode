import {
	type BillingServerConfig,
	billingServerConfigSchema,
} from "@wincode/billing/server";
import { env } from "@wincode/env/server";

const toBigintOrUndefined = (value: string | undefined) => {
	if (value === undefined) {
		return;
	}
	try {
		return BigInt(value);
	} catch {
		return;
	}
};

const toCsvOrUndefined = (value: string | undefined) => value;

const rawBillingConfig = {
	alphaUserAllowlist: toCsvOrUndefined(env.BILLING_ALPHA_USER_ALLOWLIST),
	dailyGlobalCostCapUsdMicros: toBigintOrUndefined(
		env.BILLING_DAILY_GLOBAL_COST_CAP_USD_MICROS
	),
	fundedRequestInputTokenLimit: toBigintOrUndefined(
		env.BILLING_FUNDED_REQUEST_INPUT_TOKEN_LIMIT
	),
	fundedRequestOutputTokenLimit: toBigintOrUndefined(
		env.BILLING_FUNDED_REQUEST_OUTPUT_TOKEN_LIMIT
	),
	fundedRequestStepLimit: toBigintOrUndefined(
		env.BILLING_FUNDED_REQUEST_STEP_LIMIT
	),
	fundedRequestTimeWindowSeconds: toBigintOrUndefined(
		env.BILLING_FUNDED_REQUEST_TIME_WINDOW_SECONDS
	),
	goProductId: env.BILLING_GO_PRODUCT_ID,
	goRollingQuotaUsdMicros: toBigintOrUndefined(
		env.BILLING_GO_ROLLING_QUOTA_USD_MICROS
	),
	mode: env.BILLING_MODE,
	modelKillSwitches: toCsvOrUndefined(env.BILLING_MODEL_KILL_SWITCHES),
	polarEnvironment: env.BILLING_POLAR_ENVIRONMENT,
	polarToken: env.BILLING_POLAR_TOKEN,
	polarWebhookSecret: env.BILLING_POLAR_WEBHOOK_SECRET,
	priceBookEffectiveDate: env.BILLING_PRICE_BOOK_EFFECTIVE_DATE,
	priceBookVersion: env.BILLING_PRICE_BOOK_VERSION,
	providerKillSwitches: toCsvOrUndefined(env.BILLING_PROVIDER_KILL_SWITCHES),
};

export const getValidatedBillingConfig = (): BillingServerConfig | null => {
	const parsed = billingServerConfigSchema.safeParse(rawBillingConfig);
	if (parsed.success) {
		return parsed.data;
	}
	if (
		rawBillingConfig.mode === undefined ||
		rawBillingConfig.mode === "disabled"
	) {
		return null;
	}
	throw new Error(`Invalid billing config: ${parsed.error.message}`);
};

export const getBillingConfig = (): BillingServerConfig | null =>
	getValidatedBillingConfig();
