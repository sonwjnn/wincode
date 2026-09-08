import path from "node:path";
import type { ZodError } from "zod";
import type {
	ConfigDiagnostic,
	ConfigOrigin,
	ConfigSnapshot,
	ConfigSource,
} from "@/shared/config/config-store";
import {
	DEFAULT_MCP_TIMEOUTS,
	mergedServerSchema,
	type ResolvedMcpServerConfig,
	rawServerPatchSchema,
	resolvedServerSchema,
} from "./schema";

const ENV_PATTERN = /^\{env:([^{}]+)\}$/;

type McpDiagnosticCode =
	| ConfigDiagnostic["code"]
	| "invalid-field"
	| "invalid-scope"
	| "invalid-server"
	| "invalid-timeout"
	| "invalid-url"
	| "missing-env"
	| "unsupported-auth";

export type McpConfigDiagnostic = Omit<ConfigDiagnostic, "code"> & {
	code: McpDiagnosticCode;
	serverName?: string;
};

export type InvalidMcpServerConfig = {
	error: string;
	name: string;
	transport: "local" | "remote";
};

const object = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const serverPath = (name: string, field: readonly string[] = []): string =>
	["mcp", name, ...field].join(".");

const addDiagnostic = (
	diagnostics: McpConfigDiagnostic[],
	origin: ConfigOrigin,
	code: McpDiagnosticCode,
	message: string,
	suffix: string,
	serverName?: string
): void => {
	diagnostics.push({
		code,
		message,
		path: `${origin.path}:${suffix}`,
		scope: origin.scope,
		...(serverName === undefined ? {} : { serverName }),
	});
};

type ResolutionContext = {
	diagnostics: McpConfigDiagnostic[];
	env: Record<string, string | undefined>;
	fallbackSource: ConfigOrigin;
	name: string;
	snapshot: ConfigSnapshot;
	workspace: string;
};

const owner = (
	context: ResolutionContext,
	field: readonly string[]
): ConfigOrigin =>
	context.snapshot.sourceFor(["mcp", context.name, ...field]) ??
	context.fallbackSource;

const diagnosticCode = (field: readonly string[]): McpDiagnosticCode => {
	const rootField = field[0] ?? "";
	if (rootField === "timeout") {
		return "invalid-timeout";
	}
	if (rootField === "command" || rootField === "type") {
		return "invalid-server";
	}
	return "invalid-field";
};

const addSchemaDiagnostics = (
	context: ResolutionContext,
	error: ZodError
): void => {
	for (const issue of error.issues) {
		const parent = issue.path.map(String);
		const fields =
			issue.code === "unrecognized_keys"
				? issue.keys.map((key) => [...parent, key])
				: [parent];
		for (const field of fields) {
			addDiagnostic(
				context.diagnostics,
				owner(context, field),
				diagnosticCode(field),
				issue.message,
				serverPath(context.name, field),
				context.name
			);
		}
	}
};

const resolveString = (
	value: unknown,
	context: ResolutionContext,
	field: readonly string[]
): string | undefined => {
	if (typeof value !== "string") {
		return;
	}
	const match = ENV_PATTERN.exec(value);
	if (match === null) {
		return value;
	}
	const variable = match[1] ?? "";
	const resolved = context.env[variable];
	if (typeof resolved === "string") {
		return resolved;
	}
	addDiagnostic(
		context.diagnostics,
		owner(context, field),
		"missing-env",
		`Missing environment variable ${variable} for server ${context.name}`,
		serverPath(context.name, field),
		context.name
	);
};

const resolveLocalServer = (
	context: ResolutionContext,
	base: object,
	raw: Record<string, unknown>
): ResolvedMcpServerConfig | undefined => {
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(
		object(raw.environment) ? raw.environment : {}
	)) {
		const resolved = resolveString(value, context, ["environment", key]);
		if (resolved === undefined) {
			return;
		}
		environment[key] = resolved;
	}
	const cwd = typeof raw.cwd === "string" ? raw.cwd : undefined;
	const parsed = resolvedServerSchema.safeParse({
		...base,
		type: "local" as const,
		command: raw.command,
		...(cwd === undefined
			? {}
			: {
					cwd:
						path.isAbsolute(cwd) || path.win32.isAbsolute(cwd)
							? cwd
							: path.resolve(context.workspace, cwd),
				}),
		...(Object.keys(environment).length === 0 ? {} : { environment }),
	});
	if (!parsed.success) {
		addSchemaDiagnostics(context, parsed.error);
		return;
	}
	return parsed.data;
};

const resolveRemoteServer = (
	context: ResolutionContext,
	base: object,
	raw: Record<string, unknown>
): ResolvedMcpServerConfig | undefined => {
	let url: URL;
	try {
		url = new URL(String(raw.url));
		if (!(url.hostname && ["http:", "https:"].includes(url.protocol))) {
			throw new Error("Invalid URL");
		}
	} catch {
		addDiagnostic(
			context.diagnostics,
			owner(context, ["url"]),
			"invalid-url",
			"URL must be absolute http or https URL",
			serverPath(context.name, ["url"]),
			context.name
		);
		return;
	}
	if (raw.oauth !== undefined && raw.oauth !== false) {
		addDiagnostic(
			context.diagnostics,
			owner(context, ["oauth"]),
			"unsupported-auth",
			"OAuth configuration is unsupported",
			serverPath(context.name, ["oauth"]),
			context.name
		);
		return;
	}
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(
		object(raw.headers) ? raw.headers : {}
	)) {
		const resolved = resolveString(value, context, ["headers", key]);
		if (resolved === undefined) {
			return;
		}
		headers[key] = resolved;
	}
	const parsed = resolvedServerSchema.safeParse({
		...base,
		type: "remote" as const,
		url: url.toString(),
		...(Object.keys(headers).length === 0 ? {} : { headers }),
		...(raw.oauth === false ? { oauth: false as const } : {}),
	});
	if (!parsed.success) {
		addSchemaDiagnostics(context, parsed.error);
		return;
	}
	return parsed.data;
};

const resolveServer = (
	context: ResolutionContext,
	raw: ReturnType<typeof rawServerPatchSchema.parse>
): ResolvedMcpServerConfig | undefined => {
	const mergedServer = mergedServerSchema.safeParse(raw);
	if (!mergedServer.success) {
		addSchemaDiagnostics(context, mergedServer.error);
		return;
	}
	const value = mergedServer.data;
	const base = {
		disabled: value.enabled === false,
		name: context.name,
		permission: value.permission ?? "ask",
		timeout: { ...DEFAULT_MCP_TIMEOUTS, ...value.timeout },
	};
	return value.type === "local"
		? resolveLocalServer(context, base, value)
		: resolveRemoteServer(context, base, value);
};

const diagnoseMalformedEntries = (
	sources: readonly ConfigSource[],
	diagnostics: McpConfigDiagnostic[]
): void => {
	for (const source of sources) {
		const mcp = source.document.mcp;
		if (mcp === undefined) {
			continue;
		}
		if (!object(mcp)) {
			addDiagnostic(
				diagnostics,
				source,
				"invalid-scope",
				"mcp must be object",
				"mcp"
			);
			continue;
		}
		for (const [name, value] of Object.entries(mcp)) {
			if (!object(value)) {
				addDiagnostic(
					diagnostics,
					source,
					"invalid-server",
					"Server entry must be an object",
					serverPath(name),
					name
				);
			}
		}
	}
};

type ResolveInput = {
	env: Record<string, string | undefined>;
	snapshot: ConfigSnapshot;
	workspace: string;
};

export const resolveServers = ({
	env,
	snapshot,
	workspace,
}: ResolveInput): {
	diagnostics: McpConfigDiagnostic[];
	invalidServers?: Record<string, InvalidMcpServerConfig>;
	servers: Record<string, ResolvedMcpServerConfig>;
} => {
	const diagnostics: McpConfigDiagnostic[] = snapshot.diagnostics.map(
		(diagnostic) => ({ ...diagnostic })
	);
	diagnoseMalformedEntries(snapshot.sources, diagnostics);
	const section = object(snapshot.document.mcp) ? snapshot.document.mcp : {};
	const servers: Record<string, ResolvedMcpServerConfig> = {};
	for (const [name, raw] of Object.entries(section)) {
		if (!object(raw)) {
			continue;
		}
		const fallbackSource = snapshot.sourceFor(["mcp", name]);
		if (fallbackSource === undefined) {
			continue;
		}
		const context: ResolutionContext = {
			diagnostics,
			env,
			fallbackSource,
			name,
			snapshot,
			workspace,
		};
		const validated = rawServerPatchSchema.safeParse(raw);
		if (!validated.success) {
			addSchemaDiagnostics(context, validated.error);
			continue;
		}
		const resolved = resolveServer(context, validated.data);
		if (resolved !== undefined) {
			servers[name] = resolved;
		}
	}
	const invalidServers: Record<string, InvalidMcpServerConfig> = {};
	for (const [name, raw] of Object.entries(section)) {
		if (
			servers[name] !== undefined ||
			!object(raw) ||
			(raw.type !== "local" && raw.type !== "remote")
		) {
			continue;
		}
		const diagnostic = diagnostics.find((item) => item.serverName === name);
		invalidServers[name] = {
			error: diagnostic?.message ?? "Invalid MCP server configuration",
			name,
			transport: raw.type,
		};
	}
	return { diagnostics, invalidServers, servers };
};
