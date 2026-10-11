import { logger } from "@wincode/utils";
import { z } from "zod";

const emptyStringAsUndefined = (
	value: string | undefined
): string | undefined => (value === "" ? undefined : value);

const offlineOverrideSchema = z
	.enum(["0", "1", "false", "true"])
	.optional()
	.transform((value) => value === "1" || value === "true");
const ttlHoursOverrideSchema = z.coerce.number().int().positive().optional();
const urlOverrideSchema = z.url().optional();

const modelPricingEnvSchema = z.object({
	WINCODE_MODEL_PRICING_OFFLINE: offlineOverrideSchema,
	WINCODE_MODEL_PRICING_TTL_HOURS: ttlHoursOverrideSchema,
	WINCODE_MODEL_PRICING_URL: urlOverrideSchema,
});

type ModelPricingEnv = z.infer<typeof modelPricingEnvSchema>;

const parseOverride = <Output>(
	schema: z.ZodType<Output>,
	name: string
): Output | undefined => {
	const parsed = schema.safeParse(emptyStringAsUndefined(process.env[name]));
	if (parsed.success) {
		return parsed.data;
	}
	logger.warn("Ignoring invalid model pricing environment override", {
		issues: parsed.error.issues.map((issue) => issue.message),
		name,
	});
	return;
};

/**
 * Reads the pricing overrides when called, not when this module loads, so a
 * test or caller that sets them after import still reaches the provider. Each
 * variable falls back on its own: one malformed override must not drop the
 * others, or a valid offline flag would be lost and a fetch would still fire.
 */
export const getModelPricingEnv = (): ModelPricingEnv => {
	const offline = parseOverride(
		offlineOverrideSchema,
		"WINCODE_MODEL_PRICING_OFFLINE"
	);
	const ttlHours = parseOverride(
		ttlHoursOverrideSchema,
		"WINCODE_MODEL_PRICING_TTL_HOURS"
	);
	const url = parseOverride(urlOverrideSchema, "WINCODE_MODEL_PRICING_URL");
	return {
		WINCODE_MODEL_PRICING_OFFLINE: offline ?? false,
		...(ttlHours === undefined
			? {}
			: { WINCODE_MODEL_PRICING_TTL_HOURS: ttlHours }),
		...(url === undefined ? {} : { WINCODE_MODEL_PRICING_URL: url }),
	};
};
