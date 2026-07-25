import { Polar } from "@polar-sh/sdk";
import { env } from "@wincode/env/server";

export const createPolarClient = () =>
	new Polar({
		accessToken: env.BILLING_POLAR_TOKEN ?? "",
		server: env.BILLING_POLAR_ENVIRONMENT,
	});
