import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { env } from "@wincode/env/web";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
	baseURL: env.VITE_SERVER_URL,
	plugins: [oauthProviderClient()],
});
