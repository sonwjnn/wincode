import { z } from "zod";

const emptyStringAsUndefined = (
	value: string | undefined
): string | undefined => (value === "" ? undefined : value);

const modelPricingEnvSchema = z.object({
	WINCODE_MODEL_PRICING_OFFLINE: z
		.enum(["0", "1", "false", "true"])
		.optional()
		.transform((value) => value === "1" || value === "true"),
	WINCODE_MODEL_PRICING_TTL_HOURS: z.coerce
		.number()
		.int()
		.positive()
		.optional(),
	WINCODE_MODEL_PRICING_URL: z.url().optional(),
});

type ModelPricingEnv = z.infer<typeof modelPricingEnvSchema>;

/**
 * Reads the pricing overrides when called, not when this module loads, so a
 * test or caller that sets them after import still reaches the provider.
 */
export const getModelPricingEnv = (): ModelPricingEnv =>
	modelPricingEnvSchema.parse({
		WINCODE_MODEL_PRICING_OFFLINE: emptyStringAsUndefined(
			process.env.WINCODE_MODEL_PRICING_OFFLINE
		),
		WINCODE_MODEL_PRICING_TTL_HOURS: emptyStringAsUndefined(
			process.env.WINCODE_MODEL_PRICING_TTL_HOURS
		),
		WINCODE_MODEL_PRICING_URL: emptyStringAsUndefined(
			process.env.WINCODE_MODEL_PRICING_URL
		),
	});
