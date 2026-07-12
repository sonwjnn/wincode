import { oauthProvider } from "@better-auth/oauth-provider";
import { createDrizzleClient, schema } from "@wincode/db/client";
import { env } from "@wincode/env/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { verifyAccessToken as oauth2VerifyAccessToken } from "better-auth/oauth2";
import { jwt } from "better-auth/plugins";

const canonicalServerUrl = new URL(env.BETTER_AUTH_URL).origin;

export function createAuth() {
	const db = createDrizzleClient();

	return betterAuth({
		database: drizzleAdapter(db, {
			provider: "pg",
			schema: {
				account: schema.account,
				oauthAccessToken: schema.oauthAccessToken,
				oauthClient: schema.oauthClient,
				oauthConsent: schema.oauthConsent,
				oauthRefreshToken: schema.oauthRefreshToken,
				jwks: schema.jwks,
				session: schema.session,
				user: schema.user,
				verification: schema.verification,
			},
		}),

		trustedOrigins: [env.CORS_ORIGIN],
		socialProviders: {
			github: {
				clientId: env.GITHUB_CLIENT_ID,
				clientSecret: env.GITHUB_CLIENT_SECRET,
			},
			google: {
				clientId: env.GOOGLE_CLIENT_ID,
				clientSecret: env.GOOGLE_CLIENT_SECRET,
			},
		},
		secret: env.BETTER_AUTH_SECRET,
		baseURL: env.BETTER_AUTH_URL,
		advanced: {
			defaultCookieAttributes: {
				sameSite: "none",
				secure: true,
				httpOnly: true,
			},
		},
		plugins: [
			jwt(),
			oauthProvider({
				consentPage: new URL("/oauth/consent", env.CORS_ORIGIN).href,
				grantTypes: ["authorization_code", "refresh_token"],
				loginPage: new URL("/login", env.CORS_ORIGIN).href,
				validAudiences: [
					canonicalServerUrl,
					new URL("/api", canonicalServerUrl).href,
				],
				scopes: ["openid", "profile", "email", "offline_access", "chat:write"],
				silenceWarnings: { oauthAuthServerConfig: true },
			}),
		],
	});
}

export const verifyAccessToken = oauth2VerifyAccessToken;

export const auth = createAuth();
