import { z } from "zod";
import {
	billingPricebookEffectiveDate,
	billingPricebookVersion,
} from "./pricing";

export {
	billingPricebook,
	billingPricebookEffectiveDate,
	billingPricebookVersion,
} from "./pricing";

export const billingOperatingModeSchema = z.enum([
	"disabled",
	"allowlist-shadow",
	"canary-enforce",
	"enforce",
]);

export type BillingOperatingMode = z.infer<typeof billingOperatingModeSchema>;

export const polarEnvironmentSchema = z.enum(["sandbox", "production"]);

const optionalCsvSchema = z.preprocess((value) => {
	if (typeof value !== "string") {
		return [];
	}
	return value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}, z.array(z.string()));

const int64Schema = z.coerce
	.bigint()
	.refine(
		(value) => value >= -(2n ** 63n) && value <= 2n ** 63n - 1n,
		"int64 out of bounds"
	);
const safeExpiryMsSchema = z.coerce
	.bigint()
	.refine(
		(value) => value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER),
		"expiry out of bounds"
	);
const safeTimeWindowSecondsSchema = z.coerce
	.bigint()
	.refine(
		(value) => value >= 1n && value <= 9_007_199_254n,
		"time window out of bounds"
	);
const boundedCountSchema = z.coerce
	.bigint()
	.refine(
		(value) => value >= 0n && value <= 2n ** 63n - 1n,
		"count out of bounds"
	);
const positiveBoundedCountSchema = z.coerce
	.bigint()
	.refine(
		(value) => value >= 1n && value <= 2n ** 63n - 1n,
		"count out of bounds"
	);

const billingServerConfigBaseSchema = z.object({
	mode: billingOperatingModeSchema.default("disabled"),
	polarEnvironment: polarEnvironmentSchema.default("sandbox"),
	polarToken: z.string().min(1).optional(),
	polarWebhookSecret: z.string().min(1).optional(),
	goProductId: z.string().min(1).optional(),
	goRollingQuotaUsdMicros: boundedCountSchema.optional(),
	dailyGlobalCostCapUsdMicros: boundedCountSchema.optional(),
	fundedRequestInputTokenLimit: positiveBoundedCountSchema.optional(),
	fundedRequestOutputTokenLimit: positiveBoundedCountSchema.optional(),
	fundedRequestStepLimit: positiveBoundedCountSchema.optional(),
	fundedRequestTimeWindowSeconds: safeTimeWindowSecondsSchema.optional(),
	priceBookVersion: z.string().min(1).optional(),
	priceBookEffectiveDate: z.string().min(1).optional(),
	alphaUserAllowlist: optionalCsvSchema
		.optional()
		.transform((items) => new Set(items ?? [])),
	providerKillSwitches: optionalCsvSchema
		.optional()
		.transform((items) => new Set(items ?? [])),
	modelKillSwitches: optionalCsvSchema
		.optional()
		.transform((items) => new Set(items ?? [])),
	expiryMs: z.union([safeExpiryMsSchema, int64Schema]).optional(),
});

export const billingServerConfigSchema =
	billingServerConfigBaseSchema.superRefine((config, ctx) => {
		if (config.mode === "disabled") {
			return;
		}
		if (config.mode === "allowlist-shadow") {
			if (config.alphaUserAllowlist.size === 0) {
				ctx.addIssue({
					code: "custom",
					message: "allowlist-shadow requires allowlist",
				});
			}
			if (config.dailyGlobalCostCapUsdMicros === undefined) {
				ctx.addIssue({
					code: "custom",
					message: "allowlist-shadow requires daily cap",
				});
			}
			if (
				config.priceBookVersion !== billingPricebookVersion ||
				config.priceBookEffectiveDate !== billingPricebookEffectiveDate ||
				config.fundedRequestInputTokenLimit === undefined ||
				config.fundedRequestOutputTokenLimit === undefined ||
				config.fundedRequestStepLimit === undefined ||
				config.fundedRequestTimeWindowSeconds === undefined
			) {
				ctx.addIssue({
					code: "custom",
					message: "allowlist-shadow requires pricing and request limits",
				});
			}
		}
		if (
			(config.mode === "canary-enforce" || config.mode === "enforce") &&
			(config.goProductId === undefined ||
				config.polarToken === undefined ||
				config.polarWebhookSecret === undefined ||
				config.goRollingQuotaUsdMicros === undefined ||
				config.dailyGlobalCostCapUsdMicros === undefined ||
				config.fundedRequestInputTokenLimit === undefined ||
				config.fundedRequestOutputTokenLimit === undefined ||
				config.fundedRequestStepLimit === undefined ||
				config.fundedRequestTimeWindowSeconds === undefined ||
				config.priceBookVersion !== billingPricebookVersion ||
				config.priceBookEffectiveDate !== billingPricebookEffectiveDate)
		) {
			ctx.addIssue({
				code: "custom",
				message: "enforce requires local entitlement and quota config",
			});
		}
	});

export type BillingServerConfig = z.infer<typeof billingServerConfigSchema>;

export const hasGoBillingConfig = (config: BillingServerConfig): boolean =>
	config.goProductId !== undefined &&
	config.goRollingQuotaUsdMicros !== undefined &&
	config.dailyGlobalCostCapUsdMicros !== undefined;

export const getEffectiveBillingMode = (
	config: BillingServerConfig
): BillingOperatingMode => config.mode;

export const canEnforceGoBilling = (config: BillingServerConfig): boolean =>
	config.goProductId !== undefined &&
	config.goRollingQuotaUsdMicros !== undefined &&
	config.fundedRequestTimeWindowSeconds !== undefined;
