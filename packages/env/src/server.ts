import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
	server: {
		PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
		DATABASE_URL: z.string().min(1),
		BETTER_AUTH_SECRET: z.string().min(32),
		BETTER_AUTH_URL: z.url(),
		WINCODE_API_KEY_PEPPER: z.string().min(32),
		GITHUB_CLIENT_ID: z.string().min(1),
		GITHUB_CLIENT_SECRET: z.string().min(1),
		GOOGLE_CLIENT_ID: z.string().min(1),
		GOOGLE_CLIENT_SECRET: z.string().min(1),
		CORS_ORIGIN: z.url(),
		GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1),
		OPENAI_API_KEY: z.string().min(1),
		BILLING_MODE: z
			.enum(["disabled", "allowlist-shadow", "canary-enforce", "enforce"])
			.optional(),
		BILLING_ALPHA_USER_ALLOWLIST: z.string().min(1).optional(),
		BILLING_PROVIDER_KILL_SWITCHES: z.string().min(1).optional(),
		BILLING_MODEL_KILL_SWITCHES: z.string().min(1).optional(),
		BILLING_POLAR_ENVIRONMENT: z.enum(["sandbox", "production"]).optional(),
		BILLING_POLAR_TOKEN: z.string().min(1).optional(),
		BILLING_POLAR_WEBHOOK_SECRET: z.string().min(1).optional(),
		BILLING_GO_PRODUCT_ID: z.string().min(1).optional(),
		BILLING_GO_ROLLING_QUOTA_USD_MICROS: z.string().min(1).optional(),
		BILLING_DAILY_GLOBAL_COST_CAP_USD_MICROS: z.string().min(1).optional(),
		BILLING_FUNDED_REQUEST_INPUT_TOKEN_LIMIT: z.string().min(1).optional(),
		BILLING_FUNDED_REQUEST_OUTPUT_TOKEN_LIMIT: z.string().min(1).optional(),
		BILLING_FUNDED_REQUEST_STEP_LIMIT: z.string().min(1).optional(),
		BILLING_FUNDED_REQUEST_TIME_WINDOW_SECONDS: z.string().min(1).optional(),
		BILLING_PRICE_BOOK_VERSION: z.string().min(1).optional(),
		BILLING_PRICE_BOOK_EFFECTIVE_DATE: z.string().min(1).optional(),
		NODE_ENV: z
			.enum(["development", "production", "test"])
			.default("development"),
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
});
