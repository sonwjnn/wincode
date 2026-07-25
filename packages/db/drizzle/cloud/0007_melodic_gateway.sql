ALTER TABLE "billingSubscription" ADD COLUMN "providerCustomerId" text;--> statement-breakpoint
ALTER TABLE "billingSubscription" ADD COLUMN "providerProductId" text;--> statement-breakpoint
ALTER TABLE "billingSubscription" ADD COLUMN "eventSource" text;--> statement-breakpoint
ALTER TABLE "billingSubscription" ADD COLUMN "eventAt" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "billingSubscription" ADD COLUMN "cancelAt" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "billingSubscription" ADD COLUMN "endAt" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "billingWebhookInbox" ADD COLUMN "eventType" text;--> statement-breakpoint
ALTER TABLE "billingWebhookInbox" ADD COLUMN "eventSource" text;--> statement-breakpoint
ALTER TABLE "billingWebhookInbox" ADD COLUMN "eventAt" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "billingWebhookInbox" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "billingWebhookInbox" ADD COLUMN "processedAt" timestamp (3) with time zone;--> statement-breakpoint
UPDATE "billingSubscription" SET "providerCustomerId" = coalesce("providerCustomerId", "providerSubscriptionId"), "providerProductId" = coalesce("providerProductId", ''), "eventSource" = coalesce("eventSource", "provider"), "eventAt" = coalesce("eventAt", "createdAt");--> statement-breakpoint
UPDATE "billingWebhookInbox" SET "eventType" = coalesce("eventType", 'unknown'), "eventSource" = coalesce("eventSource", "provider"), "eventAt" = coalesce("eventAt", "receivedAt"), "outcome" = coalesce("outcome", 'pending');--> statement-breakpoint
ALTER TABLE "billingSubscription" ALTER COLUMN "providerCustomerId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "billingSubscription" ALTER COLUMN "providerProductId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "billingSubscription" ALTER COLUMN "eventSource" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "billingSubscription" ALTER COLUMN "eventAt" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "billingWebhookInbox" ALTER COLUMN "eventType" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "billingWebhookInbox" ALTER COLUMN "eventSource" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "billingWebhookInbox" ALTER COLUMN "eventAt" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "billingWebhookInbox" ALTER COLUMN "outcome" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "billingSubscription" ADD CONSTRAINT "billingSubscription_status_allowed" CHECK ("billingSubscription"."status" in ('active', 'trialing', 'canceled', 'past_due', 'incomplete', 'incomplete_expired', 'unpaid'));
