import { z } from "zod";

export const mcpExecutionPolicySchema = z.enum(["allow", "ask", "deny"]);

export type McpExecutionPolicy = z.infer<typeof mcpExecutionPolicySchema>;
