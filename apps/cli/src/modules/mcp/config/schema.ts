import { z } from "zod";

export const phaseTimeoutSchema = z.number().int().positive();
export const timeoutPatchSchema = z
	.object({
		startup: phaseTimeoutSchema.optional(),
		catalog: phaseTimeoutSchema.optional(),
		execution: phaseTimeoutSchema.optional(),
	})
	.strip();
export const rawServerPatchSchema = z
	.object({
		type: z.enum(["local", "remote"]).optional(),
		command: z.tuple([z.string()]).rest(z.string()).optional(),
		cwd: z.string().optional(),
		environment: z.record(z.string(), z.string()).optional(),
		url: z.string().optional(),
		headers: z.record(z.string(), z.string()).optional(),
		oauth: z
			.union([z.literal(false), z.record(z.string(), z.unknown())])
			.optional(),
		disabled: z.boolean().optional(),
		timeout: timeoutPatchSchema.optional(),
	})
	.strip();
export const localServerSchema = z.object({
	name: z.string(),
	type: z.literal("local"),
	command: z.array(z.string()).min(1),
	cwd: z.string().optional(),
	environment: z.record(z.string(), z.string()).optional(),
	disabled: z.boolean(),
	timeout: z.object({
		startup: phaseTimeoutSchema,
		catalog: phaseTimeoutSchema,
		execution: phaseTimeoutSchema,
	}),
});
export const remoteServerSchema = z.object({
	name: z.string(),
	type: z.literal("remote"),
	url: z.string(),
	headers: z.record(z.string(), z.string()).optional(),
	oauth: z.literal(false).optional(),
	disabled: z.boolean(),
	timeout: z.object({
		startup: phaseTimeoutSchema,
		catalog: phaseTimeoutSchema,
		execution: phaseTimeoutSchema,
	}),
});
export const resolvedServerSchema = z.discriminatedUnion("type", [
	localServerSchema,
	remoteServerSchema,
]);
const mergedLocalServerSchema = rawServerPatchSchema.extend({
	type: z.literal("local"),
	command: z.array(z.string()).min(1),
});
const mergedRemoteServerSchema = rawServerPatchSchema.extend({
	type: z.literal("remote"),
	url: z.string().min(1),
});
export const mergedServerSchema = z.discriminatedUnion("type", [
	mergedLocalServerSchema,
	mergedRemoteServerSchema,
]);
export type McpTimeouts = z.infer<typeof timeoutPatchSchema> & {
	startup: number;
	catalog: number;
	execution: number;
};
export type LocalMcpServerConfig = z.infer<typeof localServerSchema>;
export type RemoteMcpServerConfig = z.infer<typeof remoteServerSchema>;
export type ResolvedMcpServerConfig = z.infer<typeof resolvedServerSchema>;
export const DEFAULT_MCP_TIMEOUTS = {
	startup: 30_000,
	catalog: 30_000,
	execution: 43_200_000,
} as const;
