import { createHmac, timingSafeEqual } from "node:crypto";
import { verifyAccessToken } from "@wincode/auth";
import { createDrizzleClient } from "@wincode/db/client";
import { env } from "@wincode/env/server";

export type AuthSubject =
	| { type: "oauth"; userId: string; scopes: string[] }
	| {
			type: "api-key";
			userId: string;
			scopes: string[];
			expiresAt: Date | null;
	  };

export const unauthorizedHeaders = {
	"WWW-Authenticate": 'Bearer realm="api"',
} as const;

const apiKeyPrefix = "wck_live_";
const db = createDrizzleClient();

const toBuffer = (value: string) => Buffer.from(value, "utf8");

const constantTimeEquals = (left: string, right: string) => {
	const leftBuffer = toBuffer(left);
	const rightBuffer = toBuffer(right);
	if (leftBuffer.length !== rightBuffer.length) {
		return false;
	}
	return timingSafeEqual(leftBuffer, rightBuffer);
};

export const parseApiKey = (value: string) => {
	if (!value.startsWith(apiKeyPrefix)) {
		return null;
	}
	const parts = value.split("_");
	if (parts.length !== 4) {
		return null;
	}
	const lookupPrefix = parts[2];
	const secret = parts[3];
	if (!lookupPrefix) {
		return null;
	}
	if (!secret) {
		return null;
	}
	return { lookupPrefix, secret };
};

const hashSecret = (lookupPrefix: string, secret: string) =>
	createHmac("sha256", env.WINCODE_API_KEY_PEPPER)
		.update(`${lookupPrefix}_${secret}`)
		.digest("hex");

export const verifyApiKey = async (
	rawKey: string
): Promise<AuthSubject | null> => {
	const parsed = parseApiKey(rawKey);
	if (!parsed) {
		return null;
	}
	const keyRow = await db.query.apiKey.findFirst({
		columns: {
			expiresAt: true,
			revokedAt: true,
			secretHash: true,
			scopes: true,
			userId: true,
		},
		where: (apiKeyTable, { eq }) =>
			eq(apiKeyTable.lookupPrefix, parsed.lookupPrefix),
	});
	if (
		!keyRow ||
		keyRow.revokedAt ||
		(keyRow.expiresAt && keyRow.expiresAt <= new Date())
	) {
		return null;
	}
	if (
		!constantTimeEquals(
			keyRow.secretHash,
			hashSecret(parsed.lookupPrefix, parsed.secret)
		)
	) {
		return null;
	}
	return {
		expiresAt: keyRow.expiresAt ?? null,
		scopes: keyRow.scopes,
		type: "api-key",
		userId: keyRow.userId,
	};
};

export const verifyBearerAuth = async (
	authorizationHeader: string | null
): Promise<AuthSubject | null> => {
	if (!authorizationHeader) {
		return null;
	}
	if (!authorizationHeader.startsWith("Bearer ")) {
		return null;
	}
	const token = authorizationHeader.slice("Bearer ".length).trim();
	const parsedApiKey = parseApiKey(token);
	if (parsedApiKey) {
		return verifyApiKey(token);
	}
	const verifyOptions = {
		issuer: new URL("/api/auth", new URL(env.BETTER_AUTH_URL).origin).href,
		audience: new URL("/api", new URL(env.BETTER_AUTH_URL).origin).href,
	};
	try {
		const payload = await verifyAccessToken(token, {
			jwksUrl: new URL("/api/auth/jwks", env.BETTER_AUTH_URL).href,
			scopes: ["chat:write"],
			verifyOptions,
		});
		if (!payload.sub) {
			return null;
		}
		const scopes =
			typeof payload.scope === "string"
				? payload.scope.split(" ").filter(Boolean)
				: [];
		return { scopes, type: "oauth", userId: payload.sub };
	} catch {
		return null;
	}
};

export const requireScope = (subject: AuthSubject, scope: string) =>
	subject.scopes.includes(scope);
