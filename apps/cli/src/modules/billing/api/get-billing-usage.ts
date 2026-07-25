import { z } from "zod";
import type { Connections } from "@/modules/connections";
import { getHonoClient } from "@/shared/api/hono-client";

const usdMicrosSchema = z.string().regex(/^\d+$/);

export const billingUsageSchema = z.object({
	effectiveEligible: z.boolean(),
	mode: z.enum(["disabled", "allowlist-shadow", "canary-enforce", "enforce"]),
	quotaUsdMicros: usdMicrosSchema.nullable(),
	remainingUsdMicros: usdMicrosSchema.nullable(),
	usedUsdMicros: usdMicrosSchema,
	windowStartedAt: z.iso.datetime(),
});

export type BillingUsage = z.infer<typeof billingUsageSchema>;

const getAuthorizationToken = (
	authorization:
		| { kind: "api-key"; apiKey: string }
		| { kind: "bearer"; token: string }
): string =>
	authorization.kind === "bearer" ? authorization.token : authorization.apiKey;

export const getBillingUsage = async (
	connections: Connections
): Promise<BillingUsage> => {
	const authorization = await connections.authorize("wincode");
	const response = await getHonoClient().api.billing.usage.$get(
		{},
		{
			headers: {
				Authorization: `Bearer ${getAuthorizationToken(authorization)}`,
			},
		}
	);

	if (!response.ok) {
		throw new Error(
			`Billing usage request failed with status ${response.status}.`
		);
	}

	return billingUsageSchema.parse(await response.json());
};
