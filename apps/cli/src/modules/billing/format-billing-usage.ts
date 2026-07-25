import type { BillingUsage } from "./api/get-billing-usage";

const USD_MICROS_PER_CENT = 10_000n;
const CENTS_PER_DOLLAR = 100n;
const ROLLING_WINDOW_DAYS = 30;

export const formatUsdMicros = (value: string): string => {
	const cents = BigInt(value) / USD_MICROS_PER_CENT;
	const dollars = cents / CENTS_PER_DOLLAR;
	const remainder = (cents % CENTS_PER_DOLLAR).toString().padStart(2, "0");
	return `$${dollars}.${remainder}`;
};

export const getNextReleaseAt = (windowStartedAt: string): Date => {
	const nextReleaseAt = new Date(windowStartedAt);
	nextReleaseAt.setUTCDate(nextReleaseAt.getUTCDate() + ROLLING_WINDOW_DAYS);
	return nextReleaseAt;
};

export const formatBillingUsage = (
	usage: BillingUsage,
	locale = "en-US"
): string => {
	const limit =
		usage.quotaUsdMicros === null ? "—" : formatUsdMicros(usage.quotaUsdMicros);
	const nextRelease = new Intl.DateTimeFormat(locale, {
		day: "numeric",
		month: "short",
		timeZone: "UTC",
	}).format(getNextReleaseAt(usage.windowStartedAt));

	return `Go ${formatUsdMicros(usage.usedUsdMicros)}/${limit} · next ${nextRelease}`;
};
