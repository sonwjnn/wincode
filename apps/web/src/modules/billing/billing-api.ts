import { z } from "zod";
import { honoClient } from "@/utils/trpc";

const secureUrlSchema = z
	.url()
	.refine(
		(value) => new URL(value).protocol === "https:",
		"Billing redirect must use HTTPS."
	);
const redirectResponseSchema = z.object({ url: secureUrlSchema });
const usdMicrosSchema = z.string().regex(/^\d+$/);
const billingUsageSchema = z.object({
	effectiveEligible: z.boolean(),
	mode: z.enum(["disabled", "allowlist-shadow", "canary-enforce", "enforce"]),
	quotaUsdMicros: usdMicrosSchema.nullable(),
	remainingUsdMicros: usdMicrosSchema.nullable(),
	usedUsdMicros: usdMicrosSchema,
	windowStartedAt: z.iso.datetime(),
});

type BillingAction = "checkout" | "portal";

const actionErrorMessage: Record<BillingAction, string> = {
	checkout: "Checkout could not be opened. Try again.",
	portal: "Billing management could not be opened. Try again.",
};

export const createBillingRedirect = async (
	action: BillingAction
): Promise<string> => {
	const response =
		action === "checkout"
			? await honoClient.api.billing.checkout.$post(
					{},
					{ init: { credentials: "include" } }
				)
			: await honoClient.api.billing.portal.$post(
					{},
					{ init: { credentials: "include" } }
				);

	if (!response.ok) {
		throw new Error(actionErrorMessage[action]);
	}
	const parsed = redirectResponseSchema.safeParse(await response.json());
	if (!parsed.success) {
		throw new Error(actionErrorMessage[action]);
	}
	return parsed.data.url;
};

export const getBillingEligibility = async (): Promise<boolean> => {
	const response = await honoClient.api.billing.usage.$get(
		{},
		{ init: { credentials: "include" } }
	);
	if (!response.ok) {
		throw new Error("Billing status could not be loaded. Try again.");
	}
	return billingUsageSchema.parse(await response.json()).effectiveEligible;
};
