import path from "node:path";
import type { ZodError } from "zod";
import type { Diagnostic, ScopeData } from "./discovery";
import { merge, type Source } from "./merge";
import {
	DEFAULT_MCP_TIMEOUTS,
	type McpTimeouts,
	mergedServerSchema,
	type ResolvedMcpServerConfig,
	rawServerPatchSchema,
	resolvedServerSchema,
} from "./schema";

const ENV_PATTERN = /^\{env:([^{}]+)\}$/;
const object = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const source = (scope: ScopeData): Source => ({
	scope: scope.scope,
	path: scope.path,
});
const addDiagnostic = (
	out: Diagnostic[],
	scope: ScopeData,
	code: Diagnostic["code"],
	message: string,
	suffix: string,
	name?: string
): void => {
	out.push({
		scope: scope.scope,
		code,
		message,
		path: `${scope.path}:${suffix}`,
		...(name ? { serverName: name } : {}),
	});
};

const addSchemaDiagnostics = (
	context: ResolutionContext,
	error: ZodError
): void => {
	for (const issue of error.issues) {
		const field = issue.path.map(String).join(".");
		const sourceData =
			context.merged.sources.get(field) ??
			context.merged.sources.get(String(issue.path[0]));
		const scope = sourceData ?? context.project;
		const code: Diagnostic["code"] =
			field === "command" || field === "type"
				? "invalid-server"
				: "invalid-field";
		context.diagnostics.push({
			scope: scope.scope,
			code,
			message: issue.message,
			path: `${scope.path}:mcp.servers.${context.name}.${field}`,
			serverName: context.name,
		});
	}
};

const resolveString = (
	value: unknown,
	env: Record<string, string | undefined>,
	out: Diagnostic[],
	scope: ScopeData,
	name: string,
	field: string
): string | undefined => {
	if (typeof value !== "string") {
		return;
	}
	const match = ENV_PATTERN.exec(value);
	if (!match) {
		return value;
	}
	const variable = match[1] ?? "";
	const result = env[variable];
	if (typeof result !== "string") {
		addDiagnostic(
			out,
			scope,
			"missing-env",
			`Missing environment variable ${variable} for server ${name}`,
			field,
			name
		);
		return;
	}
	return result;
};

const readSection = (
	scope: ScopeData,
	out: Diagnostic[]
): Record<string, unknown> => {
	const mcp = scope.value.mcp;
	if (mcp === undefined) {
		return {};
	}
	if (!object(mcp)) {
		addDiagnostic(out, scope, "invalid-scope", "mcp must be object", "mcp");
		return {};
	}
	if (mcp.servers === undefined) {
		return {};
	}
	if (!object(mcp.servers)) {
		addDiagnostic(
			out,
			scope,
			"invalid-scope",
			"mcp.servers must be object",
			"mcp.servers"
		);
		return {};
	}
	return mcp.servers;
};

const resolveTimeouts = (
	value: unknown,
	fallback: McpTimeouts,
	out: Diagnostic[],
	scope: ScopeData,
	name?: string,
	phaseScope?: (phase: "startup" | "catalog" | "execution") => ScopeData
): McpTimeouts | undefined => {
	if (value === undefined) {
		return fallback;
	}
	if (!object(value)) {
		addDiagnostic(
			out,
			scope,
			"invalid-timeout",
			"Timeout must be object",
			"mcp.timeout",
			name
		);
		return;
	}
	const result = { ...fallback };
	for (const phase of ["startup", "catalog", "execution"] as const) {
		const phaseValue = value[phase];
		if (
			phaseValue !== undefined &&
			(typeof phaseValue !== "number" ||
				!Number.isInteger(phaseValue) ||
				phaseValue <= 0)
		) {
			addDiagnostic(
				out,
				phaseScope?.(phase) ?? scope,
				"invalid-timeout",
				`Invalid ${phase} timeout`,
				`mcp.timeout.${phase}`,
				name
			);
			return;
		}
		if (typeof phaseValue === "number") {
			result[phase] = phaseValue;
		}
	}
	return result;
};

type ResolutionContext = {
	merged: ReturnType<typeof merge>;
	mergedTimeout: McpTimeouts;
	global: ScopeData;
	project: ScopeData;
	projectEntry: unknown;
	name: string;
	diagnostics: Diagnostic[];
	env: Record<string, string | undefined>;
	workspace: string;
};
const owner = (context: ResolutionContext, key: string): ScopeData =>
	context.merged.sources.get(key)?.scope === "project" ||
	(context.merged.sources.get(key) === undefined &&
		object(context.projectEntry))
		? context.project
		: context.global;

const resolveLocalServer = (
	context: ResolutionContext,
	base: object,
	raw: Record<string, unknown>
): ResolvedMcpServerConfig | undefined => {
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(
		object(raw.environment) ? raw.environment : {}
	)) {
		const resolved = resolveString(
			value,
			context.env,
			context.diagnostics,
			owner(context, `environment.${key}`),
			context.name,
			`mcp.servers.${context.name}.environment.${key}`
		);
		if (resolved === undefined) {
			return;
		}
		environment[key] = resolved;
	}
	const cwd = typeof raw.cwd === "string" ? raw.cwd : undefined;
	const result = {
		...base,
		type: "local" as const,
		command: raw.command,
		...(cwd
			? {
					cwd:
						path.isAbsolute(cwd) || path.win32.isAbsolute(cwd)
							? cwd
							: path.resolve(context.workspace, cwd),
				}
			: {}),
		...(Object.keys(environment).length ? { environment } : {}),
	};
	const parsed = resolvedServerSchema.safeParse(result);
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
		if (!(["http:", "https:"].includes(url.protocol) && url.hostname)) {
			throw new Error("Invalid URL");
		}
	} catch {
		addDiagnostic(
			context.diagnostics,
			owner(context, "url"),
			"invalid-url",
			"URL must be absolute http or https URL",
			`mcp.servers.${context.name}.url`,
			context.name
		);
		return;
	}
	if (raw.oauth !== undefined && raw.oauth !== false) {
		addDiagnostic(
			context.diagnostics,
			owner(context, "oauth"),
			"unsupported-auth",
			"OAuth configuration is unsupported",
			`mcp.servers.${context.name}.oauth`,
			context.name
		);
		return;
	}
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(
		object(raw.headers) ? raw.headers : {}
	)) {
		const resolved = resolveString(
			value,
			context.env,
			context.diagnostics,
			owner(context, `headers.${key}`),
			context.name,
			`mcp.servers.${context.name}.headers.${key}`
		);
		if (resolved === undefined) {
			return;
		}
		headers[key] = resolved;
	}
	const parsed = resolvedServerSchema.safeParse({
		...base,
		type: "remote" as const,
		url: url.toString(),
		...(Object.keys(headers).length ? { headers } : {}),
		...(raw.oauth === false ? { oauth: false as const } : {}),
	});
	if (!parsed.success) {
		addSchemaDiagnostics(context, parsed.error);
		return;
	}
	return parsed.data;
};

const resolveServer = (
	context: ResolutionContext
): ResolvedMcpServerConfig | undefined => {
	const raw = context.merged.value;
	const scope = owner(context, "type");
	const timeout = resolveTimeouts(
		raw.timeout,
		context.mergedTimeout,
		context.diagnostics,
		owner(context, "timeout"),
		context.name,
		(phase) => owner(context, `timeout.${phase}`)
	);
	if (!timeout || (raw.type !== "local" && raw.type !== "remote")) {
		if (timeout) {
			addDiagnostic(
				context.diagnostics,
				scope,
				"invalid-server",
				"Server type must be local or remote",
				`mcp.servers.${context.name}.type`,
				context.name
			);
		}
		return;
	}
	if (raw.disabled !== undefined && typeof raw.disabled !== "boolean") {
		addDiagnostic(
			context.diagnostics,
			owner(context, "disabled"),
			"invalid-field",
			"disabled must be boolean",
			`mcp.servers.${context.name}.disabled`,
			context.name
		);
		return;
	}
	const base = {
		name: context.name,
		type: raw.type,
		disabled: raw.disabled === true,
		timeout,
	};
	return raw.type === "local"
		? resolveLocalServer(context, base, raw)
		: resolveRemoteServer(context, base, raw);
};

type ResolveInput = {
	global: ScopeData;
	project: ScopeData;
	diagnostics: Diagnostic[];
	env: Record<string, string | undefined>;
	workspace: string;
};

const resolveScopeTimeouts = (
	scope: ScopeData,
	fallback: McpTimeouts,
	diagnostics: Diagnostic[]
): McpTimeouts | undefined => {
	const mcp = object(scope.value.mcp) ? scope.value.mcp : {};
	return resolveTimeouts(mcp.timeout, fallback, diagnostics, scope);
};

const collectServerNames = (
	globalServers: Record<string, unknown>,
	projectServers: Record<string, unknown>
): Set<string> =>
	new Set([...Object.keys(globalServers), ...Object.keys(projectServers)]);

const validateServerPatch = (
	merged: ReturnType<typeof merge>,
	projectEntry: unknown,
	global: ScopeData,
	project: ScopeData,
	name: string,
	diagnostics: Diagnostic[]
): ReturnType<typeof rawServerPatchSchema.parse> | undefined => {
	const validated = rawServerPatchSchema.safeParse(merged.value);
	if (validated.success) {
		return validated.data;
	}
	for (const issue of validated.error.issues) {
		const field = issue.path.map(String).join(".");
		const sourceData =
			merged.sources.get(field) ?? merged.sources.get(String(issue.path[0]));
		const diagnosticScope =
			sourceData ?? (projectEntry === undefined ? global : project);
		let code: Diagnostic["code"] = "invalid-field";
		if (field.startsWith("timeout")) {
			code = "invalid-timeout";
		}
		if (field === "command" || field === "type") {
			code = "invalid-server";
		}
		diagnostics.push({
			scope: diagnosticScope.scope,
			code,
			message: issue.message,
			path: `${diagnosticScope.path}:mcp.servers.${name}.${field}`,
			serverName: name,
		});
	}
};

const resolveNamedServer = (
	name: string,
	globalEntry: unknown,
	projectEntry: unknown,
	global: ScopeData,
	project: ScopeData,
	mergedTimeout: McpTimeouts,
	diagnostics: Diagnostic[],
	env: Record<string, string | undefined>,
	workspace: string
): ResolvedMcpServerConfig | undefined => {
	if (globalEntry !== undefined && !object(globalEntry)) {
		addDiagnostic(
			diagnostics,
			global,
			"invalid-server",
			"Server entry must be an object",
			`mcp.servers.${name}`,
			name
		);
	}
	if (projectEntry !== undefined && !object(projectEntry)) {
		addDiagnostic(
			diagnostics,
			project,
			"invalid-server",
			"Server entry must be an object",
			`mcp.servers.${name}`,
			name
		);
		return;
	}
	const merged = merge(
		object(globalEntry) ? globalEntry : {},
		object(projectEntry) ? projectEntry : {},
		source(global),
		source(project)
	);
	const validated = validateServerPatch(
		merged,
		projectEntry,
		global,
		project,
		name,
		diagnostics
	);
	if (!validated) {
		return;
	}
	const context: ResolutionContext = {
		merged: { ...merged, value: validated },
		mergedTimeout,
		global,
		project,
		projectEntry,
		name,
		diagnostics,
		env,
		workspace,
	};
	const mergedValidated = mergedServerSchema.safeParse(validated);
	if (!mergedValidated.success) {
		addSchemaDiagnostics(context, mergedValidated.error);
		return;
	}
	return resolveServer({
		...context,
		merged: { ...merged, value: mergedValidated.data },
	});
};

export const resolveServers = ({
	global,
	project,
	diagnostics,
	env,
	workspace,
}: ResolveInput): {
	servers: Record<string, ResolvedMcpServerConfig>;
	diagnostics: Diagnostic[];
} => {
	const gs = readSection(global, diagnostics);
	const ps = readSection(project, diagnostics);
	const globalTimeout = resolveScopeTimeouts(
		global,
		DEFAULT_MCP_TIMEOUTS,
		diagnostics
	);
	const projectTimeout = resolveScopeTimeouts(
		project,
		globalTimeout ?? DEFAULT_MCP_TIMEOUTS,
		diagnostics
	);
	const servers: Record<string, ResolvedMcpServerConfig> = {};
	for (const name of collectServerNames(gs, ps)) {
		const result = resolveNamedServer(
			name,
			gs[name],
			ps[name],
			global,
			project,
			projectTimeout ?? globalTimeout ?? DEFAULT_MCP_TIMEOUTS,
			diagnostics,
			env,
			workspace
		);
		if (result) {
			servers[name] = result;
		}
	}
	return { servers, diagnostics };
};
