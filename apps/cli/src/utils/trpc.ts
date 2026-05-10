import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { AppRouter } from "@wincode/api/routers/index";

export const { useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();
