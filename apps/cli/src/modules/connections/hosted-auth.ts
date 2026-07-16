import {
	allowInsecureRequests,
	discoveryRequest,
	None,
	processDiscoveryResponse,
	processRefreshTokenResponse,
	refreshTokenGrantRequest,
} from "oauth4webapi";
import { getHonoClient } from "@/shared/api/hono-client";
import type { WincodeCredential } from "./contract";

const EXPIRY_SKEW_MS = 5 * 60 * 1000;

export const refreshWincodeOAuthCredential = async (
	credential: Extract<WincodeCredential, { kind: "oauth-session" }>,
	signal?: AbortSignal
): Promise<Extract<WincodeCredential, { kind: "oauth-session" }>> => {
	if (!isNearExpiry(credential.expiresAt)) {
		return credential;
	}
	try {
		const issuer = new URL(credential.issuer);
		const discovery = await processDiscoveryResponse(
			issuer,
			await discoveryRequest(issuer, {
				algorithm: "oauth2",
				signal,
				...(isLoopbackHttpIssuer(issuer)
					? { [allowInsecureRequests]: true }
					: {}),
			})
		);
		const response = await refreshTokenGrantRequest(
			discovery,
			{ client_id: credential.clientId },
			None(),
			credential.refreshToken,
			{ additionalParameters: { resource: credential.resource }, signal }
		);
		const token = await processRefreshTokenResponse(
			discovery,
			{ client_id: credential.clientId },
			response
		);
		if (!token.access_token) {
			throw new Error("missing access token");
		}
		if (!token.expires_in || token.expires_in <= 0) {
			throw new Error("missing expiry");
		}
		const now = new Date();
		return {
			...credential,
			accessToken: token.access_token,
			expiresAt: new Date(
				now.getTime() + token.expires_in * 1000
			).toISOString(),
			refreshToken: token.refresh_token ?? credential.refreshToken,
			scope: token.scope ?? credential.scope,
			updatedAt: now.toISOString(),
			tokenType: "Bearer",
		};
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") {
			throw error;
		}
		throw new Error("Reconnect Wincode with /connect");
	}
};

export const validateWincodeApiKey = async (
	apiKey: string,
	signal?: AbortSignal
): Promise<void> => {
	const response = await getHonoClient().api.credentials.validate.$get(
		{
			header: { Authorization: `Bearer ${apiKey}` },
		},
		{ init: { signal } }
	);
	if (!response.ok) {
		throw new Error("Wincode API key validation failed.");
	}
};

const isNearExpiry = (expiresAt: string): boolean =>
	Date.parse(expiresAt) - Date.now() <= EXPIRY_SKEW_MS;

const isLoopbackHttpIssuer = (issuer: URL): boolean =>
	issuer.protocol === "http:" &&
	(issuer.hostname === "127.0.0.1" || issuer.hostname === "::1");
