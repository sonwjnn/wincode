import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const runtimeEnv = {
	...process.env,
	SERVER_URL:
		process.env.SERVER_URL ??
		(process.env.NODE_ENV === "test" ? "http://localhost" : undefined),
	WINCODE_OAUTH_ISSUER: process.env.WINCODE_OAUTH_ISSUER,
	WINCODE_OAUTH_CLIENT_ID: process.env.WINCODE_OAUTH_CLIENT_ID,
	WINCODE_OAUTH_REDIRECT_URI: process.env.WINCODE_OAUTH_REDIRECT_URI,
};

export const env = createEnv({
	server: {
		SERVER_URL: z.url().optional(),
		WINCODE_MODEL_PRICING_OFFLINE: z
			.enum(["0", "1", "false", "true"])
			.optional()
			.transform((value) => value === "1" || value === "true"),
		WINCODE_MODEL_PRICING_TTL_HOURS: z.coerce
			.number()
			.int()
			.positive()
			.optional(),
		WINCODE_MODEL_PRICING_URL: z.url().optional(),
		WINCODE_OAUTH_ISSUER: z.url().optional(),
		WINCODE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
		WINCODE_OAUTH_REDIRECT_URI: z.url().optional(),
	},
	runtimeEnv,
	emptyStringAsUndefined: true,
});
