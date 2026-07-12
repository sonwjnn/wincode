CREATE TABLE "oauthAccessToken" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"clientId" text NOT NULL,
	"sessionId" text,
	"userId" text,
	"referenceId" text,
	"refreshId" text,
	"expiresAt" timestamp (3) NOT NULL,
	"createdAt" timestamp (3) NOT NULL,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauthAccessToken_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauthClient" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"clientSecret" text,
	"disabled" boolean DEFAULT false,
	"skipConsent" boolean,
	"enableEndSession" boolean,
	"subjectType" text,
	"scopes" text[],
	"userId" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"softwareId" text,
	"softwareVersion" text,
	"softwareStatement" text,
	"redirectUris" text[] NOT NULL,
	"postLogoutRedirectUris" text[],
	"tokenEndpointAuthMethod" text,
	"grantTypes" text[],
	"responseTypes" text[],
	"public" boolean,
	"type" text,
	"requirePKCE" boolean,
	"referenceId" text,
	"metadata" jsonb,
	CONSTRAINT "oauthClient_clientId_unique" UNIQUE("clientId")
);
--> statement-breakpoint
CREATE TABLE "oauthConsent" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"userId" text,
	"referenceId" text,
	"scopes" text[] NOT NULL,
	"createdAt" timestamp (3) NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauthRefreshToken" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"clientId" text NOT NULL,
	"sessionId" text,
	"userId" text NOT NULL,
	"referenceId" text,
	"expiresAt" timestamp (3) NOT NULL,
	"createdAt" timestamp (3) NOT NULL,
	"revoked" timestamp (3),
	"authTime" timestamp (3),
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauthRefreshToken_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_clientId_oauthClient_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "public"."oauthClient"("clientId") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_sessionId_session_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_refreshId_oauthRefreshToken_id_fk" FOREIGN KEY ("refreshId") REFERENCES "public"."oauthRefreshToken"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthClient" ADD CONSTRAINT "oauthClient_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthConsent" ADD CONSTRAINT "oauthConsent_clientId_oauthClient_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "public"."oauthClient"("clientId") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthConsent" ADD CONSTRAINT "oauthConsent_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthRefreshToken" ADD CONSTRAINT "oauthRefreshToken_clientId_oauthClient_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "public"."oauthClient"("clientId") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthRefreshToken" ADD CONSTRAINT "oauthRefreshToken_sessionId_session_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthRefreshToken" ADD CONSTRAINT "oauthRefreshToken_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauthAccessToken_clientId_index" ON "oauthAccessToken" USING btree ("clientId");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_userId_index" ON "oauthAccessToken" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "oauthClient_userId_index" ON "oauthClient" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "oauthConsent_clientId_index" ON "oauthConsent" USING btree ("clientId");--> statement-breakpoint
CREATE INDEX "oauthConsent_userId_index" ON "oauthConsent" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_clientId_index" ON "oauthRefreshToken" USING btree ("clientId");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_userId_index" ON "oauthRefreshToken" USING btree ("userId");--> statement-breakpoint
INSERT INTO "oauthClient" (
	"id",
	"clientId",
	"name",
	"redirectUris",
	"tokenEndpointAuthMethod",
	"grantTypes",
	"responseTypes",
	"public",
	"requirePKCE",
	"skipConsent",
	"scopes"
) VALUES (
	'wincode-cli',
	'wincode-cli',
	'Wincode CLI',
	ARRAY['http://127.0.0.1:8765/callback'],
	'none',
	ARRAY['authorization_code', 'refresh_token'],
	ARRAY['code'],
	true,
	true,
	true,
	ARRAY['openid', 'profile', 'email', 'offline_access', 'chat:write']
) ON CONFLICT ("clientId") DO NOTHING;
