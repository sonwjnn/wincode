import { env } from "@wincode/env/cli";
import { hc } from "hono/client";
import type { AppType } from "server";

export const honoClient = hc<AppType>(env.SERVER_URL);
