CREATE TABLE "apiKey" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"lookupPrefix" text NOT NULL,
	"secretHash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expiresAt" timestamp(3),
	"revokedAt" timestamp(3),
	"createdAt" timestamp(3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp(3) DEFAULT now() NOT NULL
);

ALTER TABLE "apiKey" ADD CONSTRAINT "apiKey_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "apiKey_lookupPrefix_unique" ON "apiKey" USING btree ("lookupPrefix");
CREATE INDEX "apiKey_userId_index" ON "apiKey" USING btree ("userId");
