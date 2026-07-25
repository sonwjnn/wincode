import { validateEvent } from "@polar-sh/sdk/webhooks";
import { createDrizzleClient } from "@wincode/db/client";
import { billingSubscription, billingWebhookInbox } from "@wincode/db/schema";
import { env } from "@wincode/env/server";
import type { InferInsertModel } from "drizzle-orm";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";

type PolarWebhookEvent = {
	type: string;
	data: {
		cancelAtPeriodEnd?: boolean;
		canceledAt?: Date | null;
		currentPeriodEnd: Date;
		currentPeriodStart: Date;
		customer: { externalId?: string | null };
		customerId: string;
		id: string;
		productId?: string | null;
		status: string;
		endedAt?: Date | null;
		endsAt?: Date | null;
	};
	timestamp: Date;
	source?: string;
};

type WebhookInboxInsert = InferInsertModel<typeof billingWebhookInbox>;
type WebhookSubscriptionInsert = InferInsertModel<typeof billingSubscription>;

const provider = "polar" as const;
const maxWebhookBodyBytes = 64 * 1024;

type DbTx = Parameters<
	Parameters<Awaited<ReturnType<typeof createDrizzleClient>>["transaction"]>[0]
>[0];

type WebhookHeaders = {
	"webhook-id": string;
	"webhook-signature": string;
	"webhook-timestamp": string;
};

const webhookHeaders = (headers: Headers): WebhookHeaders => ({
	"webhook-id": headers.get("webhook-id") ?? "",
	"webhook-signature": headers.get("webhook-signature") ?? "",
	"webhook-timestamp": headers.get("webhook-timestamp") ?? "",
});

const isMissingWebhookHeaders = (headers: WebhookHeaders): boolean =>
	headers["webhook-id"] === "" ||
	headers["webhook-signature"] === "" ||
	headers["webhook-timestamp"] === "";

const isMissingRequiredWebhookFields = (event: PolarWebhookEvent): boolean => {
	const customerExternalId = event.data.customer?.externalId;
	const parsedOccurredAt = parseDate(event.timestamp);
	if (
		typeof customerExternalId !== "string" ||
		customerExternalId.length === 0
	) {
		return true;
	}
	if (parsedOccurredAt === null) {
		return true;
	}
	if (typeof event.data.id !== "string" || event.data.id.length === 0) {
		return true;
	}
	if (
		typeof event.data.customerId !== "string" ||
		event.data.customerId.length === 0
	) {
		return true;
	}
	if (
		typeof event.data.productId !== "string" ||
		event.data.productId.length === 0
	) {
		return true;
	}
	return false;
};

const isStaleSubscriptionEvent = (
	existing: { eventAt: Date } | null,
	sourceTimestamp: Date
): boolean => {
	if (existing === null) {
		return false;
	}
	return existing.eventAt > sourceTimestamp;
};

const hasWebhookConfig = (
	billingSecret: string | undefined,
	billingProductId: string | undefined
): boolean => {
	if (billingSecret === undefined) {
		return false;
	}
	if (billingProductId === undefined) {
		return false;
	}
	return true;
};

const parseDate = (value: Date | string | null | undefined): Date | null => {
	if (value === null || value === undefined) {
		return null;
	}
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const isSubscriptionEvent = (type: string): boolean =>
	type === "subscription.created" ||
	type === "subscription.updated" ||
	type === "subscription.uncanceled" ||
	type === "subscription.active" ||
	type === "subscription.revoked" ||
	type === "subscription.canceled" ||
	type === "subscription.past_due";

const statusFromEvent = (eventType: string, dataStatus: string): string => {
	if (
		eventType === "subscription.revoked" ||
		eventType === "subscription.canceled"
	) {
		return "canceled";
	}
	return dataStatus;
};

const projectWebhook = async (
	tx: DbTx,
	input: {
		event: PolarWebhookEvent;
		webhookId: string;
		sourceTimestamp: Date;
		customerExternalId: string;
		customerId: string;
		productId: string;
	}
): Promise<void> => {
	const inboxRow: WebhookInboxInsert = {
		id: input.webhookId,
		eventAt: input.sourceTimestamp,
		eventSource: input.event.source ?? "polar",
		eventType: input.event.type,
		outcome: "projected",
		provider,
		providerWebhookId: input.webhookId,
	};
	const inserted = await tx
		.insert(billingWebhookInbox)
		.values(inboxRow)
		.onConflictDoNothing({
			target: [
				billingWebhookInbox.provider,
				billingWebhookInbox.providerWebhookId,
			],
		})
		.returning({ id: billingWebhookInbox.id });
	if (inserted.length === 0) {
		return;
	}
	const existing =
		(await tx.query.billingSubscription.findFirst({
			where: and(
				eq(billingSubscription.provider, provider),
				eq(billingSubscription.providerSubscriptionId, input.event.data.id)
			),
		})) ?? null;
	if (isStaleSubscriptionEvent(existing, input.sourceTimestamp)) {
		return;
	}
	if (input.productId !== env.BILLING_GO_PRODUCT_ID) {
		await tx
			.update(billingSubscription)
			.set({
				endAt:
					parseDate(input.event.data.endedAt) ??
					parseDate(input.event.data.endsAt) ??
					input.sourceTimestamp,
				status: "canceled",
				eventAt: input.sourceTimestamp,
				updatedAt: input.sourceTimestamp,
			})
			.where(
				and(
					eq(billingSubscription.provider, provider),
					eq(billingSubscription.providerCustomerId, input.customerId),
					eq(
						billingSubscription.providerProductId,
						env.BILLING_GO_PRODUCT_ID as string
					),
					eq(billingSubscription.providerSubscriptionId, input.event.data.id),
					sql`${billingSubscription.eventAt} <= ${input.sourceTimestamp}`
				)
			);
		await tx
			.update(billingWebhookInbox)
			.set({ processedAt: new Date(), outcome: "projected" })
			.where(
				and(
					eq(billingWebhookInbox.provider, provider),
					eq(billingWebhookInbox.providerWebhookId, input.webhookId)
				)
			);
		return;
	}
	if (
		existing !== null &&
		(existing.providerCustomerId !== input.customerId ||
			existing.userId !== input.customerExternalId ||
			existing.providerProductId !== input.productId)
	) {
		return;
	}
	const status = statusFromEvent(input.event.type, input.event.data.status);
	const isCancel = status === "canceled";
	const isActive = status === "active";
	const subscriptionRow: WebhookSubscriptionInsert = {
		id: input.event.data.id,
		cancelAt: input.event.data.cancelAtPeriodEnd ? input.sourceTimestamp : null,
		canceledAt: isActive
			? null
			: (parseDate(input.event.data.canceledAt) ??
				(isCancel ? input.sourceTimestamp : null)),
		currentPeriodEndAt: parseDate(input.event.data.currentPeriodEnd),
		currentPeriodStartAt: parseDate(input.event.data.currentPeriodStart),
		endAt: isActive
			? null
			: (parseDate(input.event.data.endedAt) ??
				parseDate(input.event.data.endsAt) ??
				(isCancel ? input.sourceTimestamp : null)),
		eventAt: input.sourceTimestamp,
		eventSource: input.event.source ?? "polar",
		provider,
		providerCustomerId: input.customerId,
		providerProductId: input.productId,
		providerSubscriptionId: input.event.data.id,
		status,
		updatedAt: input.sourceTimestamp,
		userId: input.customerExternalId,
	};
	await tx
		.insert(billingSubscription)
		.values(subscriptionRow)
		.onConflictDoUpdate({
			target: [
				billingSubscription.provider,
				billingSubscription.providerSubscriptionId,
			],
			set: {
				cancelAt: subscriptionRow.cancelAt,
				canceledAt: subscriptionRow.canceledAt,
				currentPeriodEndAt: subscriptionRow.currentPeriodEndAt,
				currentPeriodStartAt: subscriptionRow.currentPeriodStartAt,
				endAt: subscriptionRow.endAt,
				eventAt: input.sourceTimestamp,
				providerProductId: input.productId,
				status,
				updatedAt: input.sourceTimestamp,
			},
			where: and(
				eq(billingSubscription.providerCustomerId, input.customerId),
				eq(billingSubscription.userId, input.customerExternalId),
				sql`${billingSubscription.eventAt} <= excluded."eventAt"`
			),
		});
	await tx
		.update(billingWebhookInbox)
		.set({ processedAt: new Date(), outcome: "projected" })
		.where(
			and(
				eq(billingWebhookInbox.provider, provider),
				eq(billingWebhookInbox.providerWebhookId, input.webhookId)
			)
		);
};

export const billingWebhookRoutes = new Hono().post("/polar", async (c) => {
	const billingSecret = env.BILLING_POLAR_WEBHOOK_SECRET;
	const billingProductId = env.BILLING_GO_PRODUCT_ID;
	if (!hasWebhookConfig(billingSecret, billingProductId)) {
		return c.json({ error: "Billing unavailable" }, 503);
	}
	const body = await c.req.arrayBuffer();
	if (body.byteLength > maxWebhookBodyBytes) {
		return c.json({ error: "Payload too large" }, 413);
	}
	const headers = webhookHeaders(c.req.raw.headers);
	if (isMissingWebhookHeaders(headers)) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	let event: PolarWebhookEvent;
	try {
		event = validateEvent(
			Buffer.from(body),
			headers,
			billingSecret as string
		) as unknown as PolarWebhookEvent;
	} catch {
		return c.json({ error: "Unauthorized" }, 401);
	}
	if (!isSubscriptionEvent(event.type)) {
		return c.json({ ok: true });
	}
	if (isMissingRequiredWebhookFields(event)) {
		return c.json({ ok: true });
	}
	const customerExternalId = event.data.customer?.externalId as string;
	const sourceTimestamp = parseDate(event.timestamp) as Date;
	const webhookId = headers["webhook-id"];
	const db = createDrizzleClient();
	try {
		await db.transaction(async (tx) => {
			await projectWebhook(tx, {
				event,
				webhookId: webhookId as string,
				sourceTimestamp: sourceTimestamp as Date,
				customerExternalId: customerExternalId as string,
				customerId: event.data.customerId,
				productId: event.data.productId as string,
			});
		});
		return c.json({ ok: true });
	} catch (error) {
		console.error("billing webhook projection failed", {
			eventType: event.type,
			webhookId,
			error,
		});
		return c.json({ error: "Billing unavailable" }, 503);
	}
});
