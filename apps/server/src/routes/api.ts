import { Hono } from "hono";
import { sessionsRoutes } from "./sessions";

export const apiRoutes = new Hono().route("/sessions", sessionsRoutes);
