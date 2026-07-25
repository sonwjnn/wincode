-- Re-seed the pre-registered `wincode-cli` public OAuth client.
-- The row is created in 0001, but environments whose migration history was
-- replayed after the row was removed end up without it, and every CLI browser
-- sign-in then fails with `invalid_client`. Idempotent: no-op when present.
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
