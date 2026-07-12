import {
	allowInsecureRequests,
	discoveryRequest,
	None,
	processDiscoveryResponse,
	processRefreshTokenResponse,
	refreshTokenGrantRequest,
} from "oauth4webapi";
import { getHonoClient } from "@/shared/api/hono-client";
import type { ConnectionsBackend } from "./storage";
import type { WincodeCredential } from "./types";

const EXPIRY_SKEW_MS = 5 * 60 * 1000;

type HostedBearerCredential = Extract<
	WincodeCredential,
	{ kind: "api-key" | "oauth-session" }
>;

type RefreshState = {
	promise?: Promise<string>;
};

const refreshStates = new WeakMap<ConnectionsBackend, RefreshState>();

export const getHostedBearer = async (
	backend: ConnectionsBackend
): Promise<string> => {
	const credential = (await backend.load(
		"wincode"
	)) as HostedBearerCredential | null;
	if (credential === null) {
		throw new Error("Reconnect Wincode with /connect");
	}
	if (credential.kind === "api-key") {
		return credential.apiKey;
	}
	if (!isNearExpiry(credential.expiresAt)) {
		return credential.accessToken;
	}

	const state = refreshStates.get(backend) ?? {};
	refreshStates.set(backend, state);
	state.promise ??= refreshHostedSession(backend, credential).finally(() => {
		state.promise = undefined;
	});
	return state.promise;
};

export const validateWincodeApiKey = async (apiKey: string): Promise<void> => {
	const response = await getHonoClient().api.credentials.validate.$get({
		header: { Authorization: `Bearer ${apiKey}` },
	});
	if (!response.ok) {
		throw new Error("Wincode API key validation failed.");
	}
};

const refreshHostedSession = async (
	backend: ConnectionsBackend,
	credential: Extract<WincodeCredential, { kind: "oauth-session" }>
): Promise<string> => {
	try {
		const issuer = new URL(credential.issuer);
		const discovery = await processDiscoveryResponse(
			issuer,
			await discoveryRequest(issuer, {
				algorithm: "oauth2",
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
			{ additionalParameters: { resource: credential.resource } }
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
		const next = {
			...credential,
			accessToken: token.access_token,
			expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
			refreshToken: token.refresh_token ?? credential.refreshToken,
			scope: token.scope ?? credential.scope,
			updatedAt: new Date().toISOString(),
			tokenType: "Bearer" as const,
		};
		await backend.replaceValidated("wincode", next);
		return next.accessToken;
	} catch {
		throw new Error("Reconnect Wincode with /connect");
	}
};

const isNearExpiry = (expiresAt: string): boolean =>
	Date.parse(expiresAt) - Date.now() <= EXPIRY_SKEW_MS;

const isLoopbackHttpIssuer = (issuer: URL): boolean =>
	issuer.protocol === "http:" &&
	(issuer.hostname === "127.0.0.1" || issuer.hostname === "::1");
