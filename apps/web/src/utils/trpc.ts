import { env } from "@wincode/env/web";
import { hc } from "hono/client";
import type { AppType } from "server";

export const honoClient = hc<AppType>(env.VITE_SERVER_URL);
