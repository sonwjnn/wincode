import { z } from "zod";

export const billingProviderSchema = z.enum(["openai", "google"]);
export const billingModelIdSchema = z.enum([
	"gpt-5.4-mini",
	"gemini-2.5-flash",
]);

export const billingRuntimePairSchema = z.union([
	z.object({
		provider: z.literal("openai"),
		modelId: z.literal("gpt-5.4-mini"),
	}),
	z.object({
		provider: z.literal("google"),
		modelId: z.literal("gemini-2.5-flash"),
	}),
]);

export type BillingRuntimePair = z.infer<typeof billingRuntimePairSchema>;

export const billingUsageSchema = z
	.object({
		provider: billingProviderSchema,
		modelId: billingModelIdSchema,
		inputTokens: z.bigint().nonnegative(),
		uncachedInputTokens: z.bigint().nonnegative(),
		cacheReadTokens: z.bigint().nonnegative(),
		cacheWriteTokens: z.literal(0n),
		outputTokens: z.bigint().nonnegative(),
		reasoningTokens: z.bigint().nonnegative(),
		totalTokens: z.bigint().nonnegative(),
		modality: z.literal("text"),
	})
	.strict()
	.superRefine((usage, ctx) => {
		const pair = billingRuntimePairSchema.safeParse({
			provider: usage.provider,
			modelId: usage.modelId,
		});
		if (!pair.success) {
			ctx.addIssue({ code: "custom", message: "invalid runtime pair" });
		}
		if (usage.cacheWriteTokens !== 0n) {
			ctx.addIssue({ code: "custom", message: "cache write must be 0" });
		}
		if (
			usage.uncachedInputTokens + usage.cacheReadTokens !==
			usage.inputTokens
		) {
			ctx.addIssue({
				code: "custom",
				message: "input must equal uncached plus cache read",
			});
		}
		if (usage.reasoningTokens > usage.outputTokens) {
			ctx.addIssue({
				code: "custom",
				message: "reasoning must not exceed output",
			});
		}
		if (usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
			ctx.addIssue({
				code: "custom",
				message: "total must equal input plus output",
			});
		}
	});

export type BillingUsage = z.infer<typeof billingUsageSchema>;

export const billingNormalizedUsageSchema = z
	.object({
		provider: billingProviderSchema,
		modelId: billingModelIdSchema,
		input: z.bigint().nonnegative(),
		uncachedInput: z.bigint().nonnegative(),
		cacheRead: z.bigint().nonnegative(),
		cacheWrite: z.literal(0n),
		output: z.bigint().nonnegative(),
		reasoning: z.bigint().nonnegative(),
		total: z.bigint().nonnegative(),
		modality: z.literal("text"),
	})
	.strict()
	.superRefine((usage, ctx) => {
		const pair = billingRuntimePairSchema.safeParse({
			provider: usage.provider,
			modelId: usage.modelId,
		});
		if (!pair.success) {
			ctx.addIssue({ code: "custom", message: "invalid runtime pair" });
		}
		if (usage.cacheWrite !== 0n) {
			ctx.addIssue({ code: "custom", message: "cache write must be 0" });
		}
		if (usage.uncachedInput + usage.cacheRead !== usage.input) {
			ctx.addIssue({
				code: "custom",
				message: "input must equal uncached plus cache read",
			});
		}
		if (usage.reasoning > usage.output) {
			ctx.addIssue({
				code: "custom",
				message: "reasoning must not exceed output",
			});
		}
		if (usage.total !== usage.input + usage.output) {
			ctx.addIssue({
				code: "custom",
				message: "total must equal input plus output",
			});
		}
	});

export type BillingNormalizedUsage = z.infer<
	typeof billingNormalizedUsageSchema
>;

type PricingRule = {
	inputMicrosPerMillionTokens: bigint;
	cacheReadMicrosPerMillionTokens: bigint;
	outputMicrosPerMillionTokens: bigint;
};

export const billingPricebookVersion = "2026-07-19" as const;
export const billingPricebookEffectiveDate = "2026-07-19" as const;

export const billingPricebook = Object.freeze({
	version: billingPricebookVersion,
	effectiveDate: billingPricebookEffectiveDate,
	models: Object.freeze({
		"gpt-5.4-mini": Object.freeze({
			inputMicrosPerMillionTokens: 750000n,
			cacheReadMicrosPerMillionTokens: 75000n,
			outputMicrosPerMillionTokens: 4500000n,
		}),
		"gemini-2.5-flash": Object.freeze({
			inputMicrosPerMillionTokens: 300000n,
			cacheReadMicrosPerMillionTokens: 30000n,
			outputMicrosPerMillionTokens: 2500000n,
		}),
	}),
});

export const getBillingProviderModelSnapshot = (pair: BillingRuntimePair) =>
	Object.freeze({
		...pair,
		inputMicrosPerMillionTokens:
			billingPricebook.models[pair.modelId].inputMicrosPerMillionTokens,
		cacheReadMicrosPerMillionTokens:
			billingPricebook.models[pair.modelId].cacheReadMicrosPerMillionTokens,
		cacheWriteMicrosPerMillionTokens: 0n,
		outputMicrosPerMillionTokens:
			billingPricebook.models[pair.modelId].outputMicrosPerMillionTokens,
		reasoningMicrosPerMillionTokens: 0n,
		version: billingPricebookVersion,
		effectiveDate: billingPricebookEffectiveDate,
	});

const pricingRegistry: Record<
	z.infer<typeof billingModelIdSchema>,
	PricingRule
> = {
	"gpt-5.4-mini": {
		inputMicrosPerMillionTokens: 750000n,
		cacheReadMicrosPerMillionTokens: 75000n,
		outputMicrosPerMillionTokens: 4500000n,
	},
	"gemini-2.5-flash": {
		inputMicrosPerMillionTokens: 300000n,
		cacheReadMicrosPerMillionTokens: 30000n,
		outputMicrosPerMillionTokens: 2500000n,
	},
};

const microTokens = 1_000_000n;

const roundUpMicros = (tokens: bigint, ratePerMillion: bigint): bigint =>
	tokens === 0n
		? 0n
		: (tokens * ratePerMillion + microTokens - 1n) / microTokens;

const assertSupportedUsageShape = (usage: BillingUsage) => {
	if (usage.provider === "google" && usage.modality !== "text") {
		throw new Error("invalid usage: gemini text-only");
	}
	if (usage.uncachedInputTokens + usage.cacheReadTokens !== usage.inputTokens) {
		throw new Error("invalid usage: inconsistent input totals");
	}
	if (usage.reasoningTokens > usage.outputTokens) {
		throw new Error("invalid usage: reasoning exceeds output");
	}
	if (usage.cacheWriteTokens !== 0n) {
		throw new Error("invalid usage: unsupported cache write");
	}
};

export const calculateUsageUsdMicros = (
	pair: BillingRuntimePair,
	usage: BillingUsage
): bigint => {
	assertSupportedUsageShape(usage);
	if (usage.provider !== pair.provider || usage.modelId !== pair.modelId) {
		throw new Error("invalid usage: model mismatch");
	}
	const price = pricingRegistry[pair.modelId];
	return (
		roundUpMicros(
			usage.uncachedInputTokens,
			price.inputMicrosPerMillionTokens
		) +
		roundUpMicros(
			usage.cacheReadTokens,
			price.cacheReadMicrosPerMillionTokens
		) +
		roundUpMicros(usage.outputTokens, price.outputMicrosPerMillionTokens)
	);
};

export const calculateNormalizedUsageUsdMicros = (
	pair: BillingRuntimePair,
	usage: BillingNormalizedUsage
): bigint => {
	if (usage.provider !== pair.provider || usage.modelId !== pair.modelId) {
		throw new Error("invalid usage: model mismatch");
	}
	return (
		roundUpMicros(
			usage.uncachedInput,
			pricingRegistry[pair.modelId].inputMicrosPerMillionTokens
		) +
		roundUpMicros(
			usage.cacheRead,
			pricingRegistry[pair.modelId].cacheReadMicrosPerMillionTokens
		) +
		roundUpMicros(
			usage.output,
			pricingRegistry[pair.modelId].outputMicrosPerMillionTokens
		)
	);
};

export const isSupportedBillingModel = (
	modelId: string
): modelId is z.infer<typeof billingModelIdSchema> =>
	billingModelIdSchema.safeParse(modelId).success;

export const getBillingRuntimePair = (
	provider: string,
	modelId: string
): BillingRuntimePair | null => {
	const parsed = billingRuntimePairSchema.safeParse({ provider, modelId });
	return parsed.success ? parsed.data : null;
};
