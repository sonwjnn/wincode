import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const runtimeEnv = {
	...process.env,
	SERVER_URL:
		process.env.SERVER_URL ??
		(process.env.NODE_ENV === "test" ? "http://localhost" : undefined),
};

export const env = createEnv({
	server: {
		SERVER_URL: z.url().optional(),
	},
	runtimeEnv,
	emptyStringAsUndefined: true,
});
