import type { SetRequired } from "type-fest";
import { z } from "zod";

export const phaseTimeoutSchema = z.number().int().positive();
export const timeoutPatchSchema = z
	.object({
		startup: phaseTimeoutSchema.optional(),
		catalog: phaseTimeoutSchema.optional(),
		execution: phaseTimeoutSchema.optional(),
	})
	.strict();

export const mcpExposureSchema = z.enum(["direct", "hidden"]);
const toolExposureSchema = z.record(z.string(), mcpExposureSchema);
const oauthSchema = z.union([
	z.literal(false),
	z.record(z.string(), z.unknown()),
]);

/** Pi-shaped entry accepted from a top-level `mcpServers` document. */
export const rawServerSchema = z
	.object({
		type: z.enum(["stdio", "http", "streamable-http"]).optional(),
		command: z.string().trim().min(1).optional(),
		args: z.array(z.string()).optional(),
		cwd: z.string().optional(),
		env: z.record(z.string(), z.string()).optional(),
		url: z.string().optional(),
		headers: z.record(z.string(), z.string()).optional(),
		auth: z.enum(["oauth"]).optional(),
		oauth: oauthSchema.optional(),
		enabled: z.boolean().optional(),
		timeout: z.number().positive().optional(),
		description: z.string().optional(),
		exposure: mcpExposureSchema.optional(),
		toolExposure: toolExposureSchema.optional(),
	})
	.strict();

export const localServerSchema = z.object({
	name: z.string(),
	type: z.literal("local"),
	command: z.array(z.string()).min(1),
	cwd: z.string().optional(),
	environment: z.record(z.string(), z.string()).optional(),
	description: z.string().optional(),
	disabled: z.boolean(),
	exposure: mcpExposureSchema.optional(),
	toolExposure: toolExposureSchema.optional(),
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
	auth: z.enum(["oauth"]).optional(),
	oauth: oauthSchema.optional(),
	description: z.string().optional(),
	disabled: z.boolean(),
	exposure: mcpExposureSchema.optional(),
	toolExposure: toolExposureSchema.optional(),
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

export type McpExposure = z.infer<typeof mcpExposureSchema>;
export type McpTimeouts = SetRequired<
	z.infer<typeof timeoutPatchSchema>,
	"startup" | "catalog" | "execution"
>;
export type LocalMcpServerConfig = z.infer<typeof localServerSchema>;
export type RemoteMcpServerConfig = z.infer<typeof remoteServerSchema>;
export type ResolvedMcpServerConfig = z.infer<typeof resolvedServerSchema>;
export type RawMcpServerConfig = z.infer<typeof rawServerSchema>;

export const DEFAULT_MCP_TIMEOUTS = {
	startup: 30_000,
	catalog: 30_000,
	execution: 60_000,
} as const;
