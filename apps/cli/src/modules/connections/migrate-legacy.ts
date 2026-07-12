import type { ConnectionsBackend } from "./storage";

export const migrateLegacyWincodeSession = async (
	readLegacyWincodeSession: () => Promise<{
		accessToken: string;
		clientId: string;
		expiresAt: string;
		issuer: string;
		refreshToken: string;
		scope: string;
		tokenType: "Bearer";
		updatedAt: string;
	} | null>,
	backend: ConnectionsBackend
): Promise<boolean> => {
	if ((await backend.load("wincode")) !== null) {
		return false;
	}
	const session = await readLegacyWincodeSession();
	if (session === null) {
		return false;
	}
	const resource = new URL("/api", session.issuer).href;
	await backend.replaceValidated("wincode", {
		...session,
		kind: "oauth-session",
		resource,
	});
	return true;
};
