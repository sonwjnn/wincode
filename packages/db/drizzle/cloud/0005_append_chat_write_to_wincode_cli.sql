UPDATE "oauthClient"
SET "scopes" = CASE
	WHEN "scopes" IS NULL THEN ARRAY['chat:write']
	WHEN NOT ('chat:write' = ANY("scopes")) THEN array_append("scopes", 'chat:write')
	ELSE "scopes"
END
WHERE "clientId" = 'wincode-cli';
