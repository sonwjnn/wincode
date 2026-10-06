import * as path from "node:path";
import {
	isNull,
	isPlainObject,
	isString,
	isUndefined,
	omitUndefined,
} from "@wincode/utils";
import type { ZodError, infer as ZodInfer } from "zod";
import {
	DEFAULT_MCP_TIMEOUTS,
	mergedServerSchema,
	type ResolvedMcpServerConfig,
	rawServerPatchSchema,
	resolvedServerSchema,
} from "./schema";

const ENV_PATTERN = /^\{env:([^{}]+)\}$/;

export type McpConfigOrigin = Readonly<{
	path: string;
	scope: string;
}>;

export type McpConfigSource = McpConfigOrigin &
	Readonly<{ document: Readonly<Record<string, unknown>> }>;

export type McpConfigDiagnosticCode =
	| "duplicate-config"
	| "parse-error"
	| "read-error"
	| "unsafe-key"
	| "invalid-field"
	| "invalid-scope"
	| "invalid-server"
	| "invalid-timeout"
	| "invalid-url"
	| "missing-env"
	| "unsupported-auth";

export type McpConfigDiagnostic = McpConfigOrigin &
	Readonly<{
		code: McpConfigDiagnosticCode;
		message: string;
		serverName?: string;
	}>;

export type McpConfigSnapshot = Readonly<{
	diagnostics: readonly McpConfigDiagnostic[];
	document: Readonly<Record<string, unknown>>;
	sourceFor(path: readonly string[]): McpConfigOrigin | undefined;
	sources: readonly McpConfigSource[];
}>;

export type McpConfigResult = Readonly<{
	diagnostics: readonly McpConfigDiagnostic[];
	invalidServers?: Readonly<Record<string, InvalidMcpServerConfig>>;
	servers: Readonly<Record<string, ResolvedMcpServerConfig>>;
}>;

export type InvalidMcpServerConfig = Readonly<{
	error: string;
	name: string;
	transport: "local" | "remote";
}>;

type McpDiagnosticCode = McpConfigDiagnosticCode;

const serverPath = (name: string, field: readonly string[] = []): string =>
	["mcp", name, ...field].join(".");

const addDiagnostic = (
	diagnostics: McpConfigDiagnostic[],
	origin: McpConfigOrigin,
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
		...omitUndefined({ serverName }),
	});
};

type ResolutionContext = {
	diagnostics: McpConfigDiagnostic[];
	env: Record<string, string | undefined>;
	fallbackSource: McpConfigOrigin;
	name: string;
	snapshot: McpConfigSnapshot;
	workspace: string;
};

const owner = (
	context: ResolutionContext,
	field: readonly string[]
): McpConfigOrigin =>
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
	if (!isString(value)) {
		return;
	}
	const match = ENV_PATTERN.exec(value);
	if (isNull(match)) {
		return value;
	}
	const variable = match[1] ?? "";
	const resolved = context.env[variable];
	if (isString(resolved)) {
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
		isPlainObject(raw.environment) ? raw.environment : {}
	)) {
		const resolved = resolveString(value, context, ["environment", key]);
		if (isUndefined(resolved)) {
			return;
		}
		environment[key] = resolved;
	}
	const cwd = isString(raw.cwd) ? raw.cwd : undefined;
	let resolvedCwd: string | undefined;
	if (!isUndefined(cwd)) {
		resolvedCwd =
			path.isAbsolute(cwd) || path.win32.isAbsolute(cwd)
				? cwd
				: path.resolve(context.workspace, cwd);
	}
	const parsed = resolvedServerSchema.safeParse({
		...base,
		type: "local" as const,
		command: raw.command,
		...omitUndefined({ cwd: resolvedCwd }),
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
	if (!isUndefined(raw.oauth) && raw.oauth !== false) {
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
		isPlainObject(raw.headers) ? raw.headers : {}
	)) {
		const resolved = resolveString(value, context, ["headers", key]);
		if (isUndefined(resolved)) {
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
	raw: ZodInfer<typeof rawServerPatchSchema>
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
	sources: readonly McpConfigSource[],
	diagnostics: McpConfigDiagnostic[]
): void => {
	for (const source of sources) {
		const mcp = source.document.mcp;
		if (isUndefined(mcp)) {
			continue;
		}
		if (!isPlainObject(mcp)) {
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
			if (!isPlainObject(value)) {
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
	env: Readonly<Record<string, string | undefined>>;
	snapshot: McpConfigSnapshot;
	workspace: string;
};

export const resolveServers = ({
	env,
	snapshot,
	workspace,
}: ResolveInput): McpConfigResult => {
	const diagnostics: McpConfigDiagnostic[] = snapshot.diagnostics.map(
		(diagnostic) => ({ ...diagnostic })
	);
	diagnoseMalformedEntries(snapshot.sources, diagnostics);
	const section = isPlainObject(snapshot.document.mcp)
		? snapshot.document.mcp
		: {};
	const servers: Record<string, ResolvedMcpServerConfig> = {};
	for (const [name, raw] of Object.entries(section)) {
		if (!isPlainObject(raw)) {
			continue;
		}
		const fallbackSource = snapshot.sourceFor(["mcp", name]);
		if (isUndefined(fallbackSource)) {
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
		if (!isUndefined(resolved)) {
			servers[name] = resolved;
		}
	}
	const invalidServers: Record<string, InvalidMcpServerConfig> = {};
	for (const [name, raw] of Object.entries(section)) {
		if (
			!(isUndefined(servers[name]) && isPlainObject(raw)) ||
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
