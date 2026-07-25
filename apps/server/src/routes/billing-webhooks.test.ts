import { describe, expect, mock, test } from "bun:test";
import type { WebhookSubscriptionActivePayload } from "@polar-sh/sdk/models/components/webhooksubscriptionactivepayload";
import { webhookSubscriptionActivePayloadToJSON } from "@polar-sh/sdk/models/components/webhooksubscriptionactivepayload";
import type { WebhookSubscriptionUncanceledPayload } from "@polar-sh/sdk/models/components/webhooksubscriptionuncanceledpayload";
import { webhookSubscriptionUncanceledPayloadToJSON } from "@polar-sh/sdk/models/components/webhooksubscriptionuncanceledpayload";
import type { WebhookSubscriptionUpdatedPayload } from "@polar-sh/sdk/models/components/webhooksubscriptionupdatedpayload";
import { webhookSubscriptionUpdatedPayloadToJSON } from "@polar-sh/sdk/models/components/webhooksubscriptionupdatedpayload";
import { Webhook } from "standardwebhooks";

const state = {
	findFirst: null as { eventAt: Date } | null,
	transactionFail: false,
	inboxIds: new Set<string>(),
	subscriptions: new Map<string, Record<string, unknown>>(),
	updates: [] as Record<string, unknown>[],
	projectedRows: [] as Record<string, unknown>[],
};

const makeTx = () => ({
	insert: () => ({
		values: (row: Record<string, unknown>) => ({
			onConflictDoNothing: () => ({
				returning: async () => {
					const id = row.providerWebhookId as string;
					if (state.inboxIds.has(id)) {
						return [];
					}
					state.inboxIds.add(id);
					return [{ id }];
				},
			}),
			onConflictDoUpdate: async () => {
				state.projectedRows.push(row);
				state.subscriptions.set(row.providerSubscriptionId as string, row);
			},
		}),
	}),
	query: {
		billingSubscription: {
			findFirst: async () =>
				state.findFirst ?? [...state.subscriptions.values()][0] ?? null,
		},
	},
	update: () => ({
		set: (values: Record<string, unknown>) => ({
			where: async () => {
				state.updates.push(values);
			},
		}),
	}),
});

mock.module("@wincode/env/server", () => ({
	env: {
		BILLING_GO_PRODUCT_ID: "prod_go",
		BILLING_POLAR_WEBHOOK_SECRET: "whsec_test",
	},
}));
mock.module("@wincode/db/client", () => ({
	createDrizzleClient: () => ({
		transaction: async (
			fn: (tx: ReturnType<typeof makeTx>) => Promise<void>
		) => {
			if (state.transactionFail) {
				throw new Error("db down");
			}
			await fn(makeTx());
		},
	}),
}));

const { billingWebhookRoutes } = await import("./billing-webhooks");

const subscription = {
	amount: 1000,
	cancelAtPeriodEnd: false,
	canceledAt: null,
	checkoutId: null,
	currency: "usd",
	currentPeriodEnd: new Date("2026-08-22T15:27:14.037Z"),
	currentPeriodStart: new Date("2026-07-22T15:27:14.037Z"),
	createdAt: new Date("2026-07-22T15:27:14.037Z"),
	customer: {
		avatarUrl: "",
		billingAddress: null,
		createdAt: new Date("2026-07-22T15:27:14.037Z"),
		deletedAt: null,
		email: "user@example.com",
		emailVerified: true,
		externalId: "user-1",
		id: "cus_1",
		metadata: {},
		modifiedAt: null,
		name: "User",
		organizationId: "org_1",
		taxId: null,
		type: "customer",
	},
	customerCancellationComment: null,
	customerCancellationReason: null,
	customerId: "cus_1",
	discount: null,
	discountId: null,
	endsAt: null,
	endedAt: null,
	id: "sub_1",
	metadata: {},
	meters: [],
	modifiedAt: null,
	pendingUpdate: null,
	prices: [],
	product: {
		attachedCustomFields: [],
		benefits: [],
		createdAt: new Date("2026-07-22T15:27:14.037Z"),
		description: null,
		id: "prod_go",
		isArchived: false,
		isRecurring: true,
		medias: [],
		metadata: {},
		modifiedAt: null,
		name: "Pro",
		organizationId: "org_1",
		prices: [],
		recurringInterval: "month" as const,
		recurringIntervalCount: 1,
		trialInterval: null,
		trialIntervalCount: null,
		visibility: "private" as const,
	},
	productId: "prod_go",
	recurringInterval: "month" as const,
	recurringIntervalCount: 1,
	seats: null,
	startedAt: null,
	status: "active",
	trialEnd: null,
	trialStart: null,
};

const buildEvent = (
	overrides: Partial<typeof subscription> = {},
	type:
		| "subscription.updated"
		| "subscription.active"
		| "subscription.uncanceled" = "subscription.updated"
): WebhookSubscriptionUpdatedPayload =>
	({
		type,
		timestamp: new Date("2026-07-22T15:27:14.037Z"),
		data: {
			...subscription,
			...overrides,
		} as WebhookSubscriptionUpdatedPayload["data"],
	}) as unknown as WebhookSubscriptionUpdatedPayload;

const sign = (body: string, webhookId: string) => {
	const ts = new Date();
	return {
		headers: {
			"webhook-id": webhookId,
			"webhook-signature": new Webhook(
				Buffer.from("whsec_test").toString("base64")
			).sign(webhookId, ts, body),
			"webhook-timestamp": `${Math.floor(ts.getTime() / 1000)}`,
		},
	};
};

const request = async (
	event: WebhookSubscriptionUpdatedPayload,
	webhookId: string
) => {
	const body =
		event.type === "subscription.updated"
			? webhookSubscriptionUpdatedPayloadToJSON(event)
			: JSON.stringify(event);
	return billingWebhookRoutes.request("/polar", {
		body,
		headers: sign(body, webhookId).headers,
		method: "POST",
	});
};

const requestUncanceled = async (webhookId: string) => {
	const event = {
		type: "subscription.uncanceled" as const,
		timestamp: new Date("2026-07-22T15:27:14.037Z"),
		data: { ...subscription, id: "sub_uncanceled", status: "active" },
	} as WebhookSubscriptionUncanceledPayload;
	const body = webhookSubscriptionUncanceledPayloadToJSON(event);
	return billingWebhookRoutes.request("/polar", {
		body,
		headers: sign(body, webhookId).headers,
		method: "POST",
	});
};

const requestActive = async (webhookId: string) => {
	const event = {
		type: "subscription.active" as const,
		timestamp: new Date("2026-07-22T15:27:14.037Z"),
		data: { ...subscription, id: "sub_active", status: "active" },
	} as WebhookSubscriptionActivePayload;
	const body = webhookSubscriptionActivePayloadToJSON(event);
	return billingWebhookRoutes.request("/polar", {
		body,
		headers: sign(body, webhookId).headers,
		method: "POST",
	});
};

describe("billing webhook route", () => {
	test("accepts valid polar webhook", async () => {
		expect((await request(buildEvent(), "evt_1")).status).toBe(200);
	});
	test("duplicate webhook 2xx", async () => {
		expect((await request(buildEvent(), "evt_dup")).status).toBe(200);
		expect((await request(buildEvent(), "evt_dup")).status).toBe(200);
		expect(state.inboxIds.size).toBe(2);
	});
	test("out-of-order webhook ignored", async () => {
		state.findFirst = { eventAt: new Date("2026-07-22T15:27:15.037Z") };
		expect((await request(buildEvent(), "evt_old")).status).toBe(200);
		state.findFirst = null;
	});
	test("unknown product ignored", async () => {
		expect(
			(await request(buildEvent({ productId: "other" }), "evt_other")).status
		).toBe(200);
	});
	test("owner mismatch ignored", async () => {
		expect(
			(
				await request(
					buildEvent({
						customer: { ...subscription.customer, externalId: "user-2" },
					}),
					"evt_owner"
				)
			).status
		).toBe(200);
	});
	test("product departure revokes prior go projection", async () => {
		state.subscriptions.set("sub_1", {
			providerSubscriptionId: "sub_1",
			providerCustomerId: "cus_1",
			userId: "user-1",
			providerProductId: "prod_go",
		});
		expect(
			(await request(buildEvent({ productId: "other" }), "evt_depart")).status
		).toBe(200);
		expect(
			state.updates.findLast((update) => update.status === "canceled")
		).toMatchObject({
			status: "canceled",
			endAt: new Date("2026-07-22T15:27:14.037Z"),
		});
	});
	test("uncanceled active event clears cancellation fields", async () => {
		const activeResponse = await requestActive("evt_active");
		expect(activeResponse.status).toBe(200);
		expect(
			state.projectedRows.find(
				(row) => row.providerSubscriptionId === "sub_active"
			)
		).toMatchObject({
			status: "active",
			cancelAt: null,
			canceledAt: null,
			endAt: null,
		});
		const uncanceledResponse = await requestUncanceled("evt_uncanceled_2");
		expect(uncanceledResponse.status).toBe(200);
		expect(
			state.projectedRows.find(
				(row) => row.providerSubscriptionId === "sub_uncanceled"
			)
		).toMatchObject({
			status: "active",
			cancelAt: null,
			canceledAt: null,
			endAt: null,
		});
	});
	test("db failure returns 503", async () => {
		state.transactionFail = true;
		expect((await request(buildEvent(), "evt_fail")).status).toBe(503);
		state.transactionFail = false;
	});
	test("rejects missing signature", async () => {
		expect(
			(
				await billingWebhookRoutes.request("/polar", {
					body: webhookSubscriptionUpdatedPayloadToJSON(buildEvent()),
					method: "POST",
				})
			).status
		).toBe(401);
	});
});
