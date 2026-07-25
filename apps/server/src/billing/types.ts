import type {
	billingRequestReservation,
	billingUsageEvent,
} from "@wincode/db/schema";

export type BillingRequestReservationRow =
	typeof billingRequestReservation.$inferSelect;
export type BillingUsageEventRow = typeof billingUsageEvent.$inferSelect;

export type BillingRepositoryUnavailable = {
	readonly ok: false;
	readonly kind: "unavailable";
	readonly reason: string;
};

export type BillingRepositoryOk<T> = { readonly ok: true } & T;

export type BillingReservationDeniedReason =
	| "not-allowlisted"
	| "daily-cap"
	| "duplicate-active-user"
	| "kill-switch"
	| "misconfigured"
	| "invalid-request"
	| "not-entitled"
	| "rolling-quota";

export type BillingReservationState =
	| "active"
	| "expired"
	| "completed"
	| "reconciliation-required"
	| "aborted";

export type BillingReservationTerminalState = Extract<
	BillingReservationState,
	"expired" | "completed" | "reconciliation-required" | "aborted"
>;

export type BillingReservationDenied = {
	readonly ok: false;
	readonly kind: "denied";
	readonly reason: BillingReservationDeniedReason;
};

export type BillingReservationAccepted = {
	readonly ok: true;
	readonly requestId: string;
	readonly reservedUsdMicros: bigint;
	readonly expiresAt: Date;
	readonly priceVersion: string;
	readonly priceEffectiveAt: Date;
};

export type BillingNormalizedUsage = {
	readonly provider: string;
	readonly modelId: string;
	readonly input: bigint;
	readonly uncachedInput: bigint;
	readonly cacheRead: bigint;
	readonly cacheWrite: bigint;
	readonly output: bigint;
	readonly reasoning: bigint;
	readonly total: bigint;
	readonly modality: string;
};
