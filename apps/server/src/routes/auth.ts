import {
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { auth } from "@wincode/auth";
import { Hono } from "hono";

const authServerMetadata = oauthProviderAuthServerMetadata(auth);
const openIdConfigMetadata = oauthProviderOpenIdConfigMetadata(auth);

export const authRoutes = new Hono()
	.get("/.well-known/openid-configuration", (c) =>
		openIdConfigMetadata(c.req.raw)
	)
	.on(["GET", "POST"], "/*", (c) => auth.handler(c.req.raw));

export const authWellKnownRoutes = new Hono().get(
	"/oauth-authorization-server/api/auth",
	(c) => authServerMetadata(c.req.raw)
);
