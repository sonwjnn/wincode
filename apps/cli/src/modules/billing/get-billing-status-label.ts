import type { BillingState } from "./billing-provider";
import { formatBillingUsage } from "./format-billing-usage";

export const getBillingStatusLabel = (
	isHosted: boolean,
	billing: BillingState
): string => {
	if (!isHosted) {
		return "BYOK";
	}
	if (billing.status === "ready") {
		return formatBillingUsage(billing.usage);
	}
	if (billing.status === "unavailable") {
		return "Go unavailable";
	}
	return "Go …";
};
