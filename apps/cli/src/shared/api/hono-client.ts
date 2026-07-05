import { env } from "@wincode/env/cli";
import { hc } from "hono/client";
import type { AppType } from "server";

export const getServerUrl = (): string => {
	if (!env.SERVER_URL) {
		throw new Error("SERVER_URL is required for AI streaming.");
	}

	return env.SERVER_URL;
};

export const getHonoClient = () => hc<AppType>(getServerUrl());
