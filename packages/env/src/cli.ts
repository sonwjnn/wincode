import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const runtimeEnv = {
	...process.env,
};

export const env = createEnv({
	server: {
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
	},
	runtimeEnv,
	emptyStringAsUndefined: true,
});
