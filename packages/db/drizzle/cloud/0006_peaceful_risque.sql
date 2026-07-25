CREATE TABLE "billingRequestReservation" (
	"requestId" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"runtimeProvider" text NOT NULL,
	"runtimeModel" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"reservedUsdMicros" bigint NOT NULL,
	"accruedUsdMicros" bigint NOT NULL,
	"priceVersion" text NOT NULL,
	"priceEffectiveAt" timestamp (3) with time zone NOT NULL,
	"rateInputUsdMicrosPerMillionTokens" bigint NOT NULL,
	"rateCacheReadUsdMicrosPerMillionTokens" bigint NOT NULL,
	"rateCacheWriteUsdMicrosPerMillionTokens" bigint NOT NULL,
	"rateOutputUsdMicrosPerMillionTokens" bigint NOT NULL,
	"rateReasoningUsdMicrosPerMillionTokens" bigint NOT NULL,
	"startedAt" timestamp (3) with time zone NOT NULL,
	"expiresAt" timestamp (3) with time zone NOT NULL,
	"finalizedAt" timestamp (3) with time zone,
	"reconciliationRequiredAt" timestamp (3) with time zone,
	"reconciliationCompletedAt" timestamp (3) with time zone,
	"createdAt" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billingRequestReservation_requestId_userId_unique" UNIQUE ("requestId", "userId"),
	CONSTRAINT "billingRequestReservation_status_allowed" CHECK ("billingRequestReservation"."status" in ('active', 'completed', 'aborted', 'expired', 'reconciliation-required')),
	CONSTRAINT "billingRequestReservation_reservedUsdMicros_nonnegative" CHECK ("billingRequestReservation"."reservedUsdMicros" >= 0),
	CONSTRAINT "billingRequestReservation_accruedUsdMicros_nonnegative" CHECK ("billingRequestReservation"."accruedUsdMicros" >= 0),
	CONSTRAINT "billingRequestReservation_rateInputUsdMicrosPerMillionTokens_nonnegative" CHECK ("billingRequestReservation"."rateInputUsdMicrosPerMillionTokens" >= 0),
	CONSTRAINT "billingRequestReservation_rateCacheReadUsdMicrosPerMillionTokens_nonnegative" CHECK ("billingRequestReservation"."rateCacheReadUsdMicrosPerMillionTokens" >= 0),
	CONSTRAINT "billingRequestReservation_rateCacheWriteUsdMicrosPerMillionTokens_nonnegative" CHECK ("billingRequestReservation"."rateCacheWriteUsdMicrosPerMillionTokens" = 0),
	CONSTRAINT "billingRequestReservation_rateOutputUsdMicrosPerMillionTokens_nonnegative" CHECK ("billingRequestReservation"."rateOutputUsdMicrosPerMillionTokens" >= 0),
	CONSTRAINT "billingRequestReservation_rateReasoningUsdMicrosPerMillionTokens_nonnegative" CHECK ("billingRequestReservation"."rateReasoningUsdMicrosPerMillionTokens" = 0)
);
--> statement-breakpoint
CREATE TABLE "billingSubscription" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"provider" text NOT NULL,
	"providerSubscriptionId" text NOT NULL,
	"status" text NOT NULL,
	"currentPeriodStartAt" timestamp (3) with time zone,
	"currentPeriodEndAt" timestamp (3) with time zone,
	"canceledAt" timestamp (3) with time zone,
	"createdAt" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billingUsageEvent" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"requestId" text NOT NULL,
	"stepIndex" bigint NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"uncachedInputTokens" bigint NOT NULL,
	"cacheReadTokens" bigint,
	"cacheWriteTokens" bigint,
	"outputTokens" bigint NOT NULL,
	"reasoningTokens" bigint,
	"totalTokens" bigint NOT NULL,
	"usdMicros" bigint NOT NULL,
	"priceVersion" text NOT NULL,
	"priceEffectiveAt" timestamp (3) with time zone NOT NULL,
	"rateInputUsdMicrosPerMillionTokens" bigint NOT NULL,
	"rateCacheReadUsdMicrosPerMillionTokens" bigint NOT NULL,
	"rateCacheWriteUsdMicrosPerMillionTokens" bigint NOT NULL,
	"rateOutputUsdMicrosPerMillionTokens" bigint NOT NULL,
	"rateReasoningUsdMicrosPerMillionTokens" bigint NOT NULL,
	"recordedAt" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billingUsageEvent_uncachedInputTokens_nonnegative" CHECK ("billingUsageEvent"."uncachedInputTokens" >= 0),
	CONSTRAINT "billingUsageEvent_stepIndex_nonnegative" CHECK ("billingUsageEvent"."stepIndex" >= 0),
	CONSTRAINT "billingUsageEvent_cacheReadTokens_nonnegative" CHECK ("billingUsageEvent"."cacheReadTokens" is null or "billingUsageEvent"."cacheReadTokens" >= 0),
	CONSTRAINT "billingUsageEvent_cacheWriteTokens_nonnegative" CHECK ("billingUsageEvent"."cacheWriteTokens" is null or "billingUsageEvent"."cacheWriteTokens" = 0),
	CONSTRAINT "billingUsageEvent_cacheWriteRateUsdMicrosPerMillionTokens_zero" CHECK ("billingUsageEvent"."rateCacheWriteUsdMicrosPerMillionTokens" = 0),
	CONSTRAINT "billingUsageEvent_outputTokens_nonnegative" CHECK ("billingUsageEvent"."outputTokens" >= 0),
	CONSTRAINT "billingUsageEvent_reasoningTokens_nonnegative" CHECK ("billingUsageEvent"."reasoningTokens" is null or "billingUsageEvent"."reasoningTokens" >= 0),
	CONSTRAINT "billingUsageEvent_totalTokens_nonnegative" CHECK ("billingUsageEvent"."totalTokens" >= 0),
	CONSTRAINT "billingUsageEvent_usdMicros_nonnegative" CHECK ("billingUsageEvent"."usdMicros" >= 0),
	CONSTRAINT "billingUsageEvent_rateInputUsdMicrosPerMillionTokens_nonnegative" CHECK ("billingUsageEvent"."rateInputUsdMicrosPerMillionTokens" >= 0),
	CONSTRAINT "billingUsageEvent_rateCacheReadUsdMicrosPerMillionTokens_nonnegative" CHECK ("billingUsageEvent"."rateCacheReadUsdMicrosPerMillionTokens" >= 0),
	CONSTRAINT "billingUsageEvent_rateCacheWriteUsdMicrosPerMillionTokens_nonnegative" CHECK ("billingUsageEvent"."rateCacheWriteUsdMicrosPerMillionTokens" >= 0),
	CONSTRAINT "billingUsageEvent_rateOutputUsdMicrosPerMillionTokens_nonnegative" CHECK ("billingUsageEvent"."rateOutputUsdMicrosPerMillionTokens" >= 0),
	CONSTRAINT "billingUsageEvent_rateReasoningUsdMicrosPerMillionTokens_nonnegative" CHECK ("billingUsageEvent"."rateReasoningUsdMicrosPerMillionTokens" >= 0),
	CONSTRAINT "billingUsageEvent_reasoningRateUsdMicrosPerMillionTokens_zero" CHECK ("billingUsageEvent"."rateReasoningUsdMicrosPerMillionTokens" = 0),
	CONSTRAINT "billingUsageEvent_totalTokens_consistent" CHECK ("billingUsageEvent"."totalTokens" = "billingUsageEvent"."uncachedInputTokens" + coalesce("billingUsageEvent"."cacheReadTokens", 0) + coalesce("billingUsageEvent"."cacheWriteTokens", 0) + "billingUsageEvent"."outputTokens"),
	CONSTRAINT "billingUsageEvent_reasoningTokens_lte_outputTokens" CHECK ("billingUsageEvent"."reasoningTokens" is null or "billingUsageEvent"."reasoningTokens" <= "billingUsageEvent"."outputTokens")
);
--> statement-breakpoint
CREATE TABLE "billingWebhookInbox" (
	"id" text PRIMARY KEY NOT NULL,
	"providerWebhookId" text NOT NULL,
	"provider" text NOT NULL,
	"receivedAt" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billingRequestReservation" ADD CONSTRAINT "billingRequestReservation_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billingSubscription" ADD CONSTRAINT "billingSubscription_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billingUsageEvent" ADD CONSTRAINT "billingUsageEvent_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billingUsageEvent" ADD CONSTRAINT "billingUsageEvent_requestId_billingRequestReservation_requestId_fk" FOREIGN KEY ("requestId") REFERENCES "public"."billingRequestReservation"("requestId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billingUsageEvent" ADD CONSTRAINT "billingUsageEvent_requestId_userId_reservation_fk" FOREIGN KEY ("requestId","userId") REFERENCES "public"."billingRequestReservation"("requestId","userId") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billingRequestReservation_userId_active_unique" ON "billingRequestReservation" USING btree ("userId") WHERE "billingRequestReservation"."status" = 'active';--> statement-breakpoint
CREATE INDEX "billingRequestReservation_userId_index" ON "billingRequestReservation" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "billingRequestReservation_status_index" ON "billingRequestReservation" USING btree ("status");--> statement-breakpoint
CREATE INDEX "billingRequestReservation_startedAt_index" ON "billingRequestReservation" USING btree ("startedAt");--> statement-breakpoint
CREATE INDEX "billingRequestReservation_expiresAt_index" ON "billingRequestReservation" USING btree ("expiresAt");--> statement-breakpoint
CREATE UNIQUE INDEX "billingSubscription_provider_providerSubscriptionId_unique" ON "billingSubscription" USING btree ("provider","providerSubscriptionId");--> statement-breakpoint
CREATE INDEX "billingSubscription_userId_index" ON "billingSubscription" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "billingUsageEvent_requestId_stepIndex_unique" ON "billingUsageEvent" USING btree ("requestId","stepIndex");--> statement-breakpoint
CREATE INDEX "billingUsageEvent_userId_index" ON "billingUsageEvent" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "billingUsageEvent_requestId_index" ON "billingUsageEvent" USING btree ("requestId");--> statement-breakpoint
CREATE INDEX "billingUsageEvent_recordedAt_index" ON "billingUsageEvent" USING btree ("recordedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "billingWebhookInbox_provider_providerWebhookId_unique" ON "billingWebhookInbox" USING btree ("provider","providerWebhookId");
