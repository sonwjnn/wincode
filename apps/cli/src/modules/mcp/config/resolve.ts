import path from "node:path";
import type { Diagnostic, ScopeData } from "./discovery";
import { merge, type Source } from "./merge";
import {
	DEFAULT_MCP_TIMEOUTS,
	type McpTimeouts,
	type ResolvedMcpServerConfig,
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
	name?: string
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
				scope,
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
	if (
		!Array.isArray(raw.command) ||
		raw.command.length === 0 ||
		raw.command.some((value) => typeof value !== "string")
	) {
		addDiagnostic(
			context.diagnostics,
			owner(context, "type"),
			"invalid-server",
			"Invalid local command",
			`mcp.servers.${context.name}.command`,
			context.name
		);
		return;
	}
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
		command: [String(raw.command[0]), ...raw.command.slice(1).map(String)] as [
			string,
			...string[],
		],
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
	return parsed.success ? parsed.data : undefined;
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
	return parsed.success ? parsed.data : undefined;
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
		context.name
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
	const globalMcp = object(global.value.mcp) ? global.value.mcp : {};
	const projectMcp = object(project.value.mcp) ? project.value.mcp : {};
	const globalTimeout = resolveTimeouts(
		globalMcp.timeout,
		DEFAULT_MCP_TIMEOUTS,
		diagnostics,
		global
	);
	const projectTimeout = resolveTimeouts(
		projectMcp.timeout,
		globalTimeout ?? DEFAULT_MCP_TIMEOUTS,
		diagnostics,
		project
	);
	const servers: Record<string, ResolvedMcpServerConfig> = {};
	for (const name of new Set([...Object.keys(gs), ...Object.keys(ps)])) {
		const gv = gs[name];
		const pv = ps[name];
		if (gv !== undefined && !object(gv)) {
			addDiagnostic(
				diagnostics,
				global,
				"invalid-server",
				"Server entry must be an object",
				`mcp.servers.${name}`,
				name
			);
		}
		if (pv !== undefined && !object(pv)) {
			addDiagnostic(
				diagnostics,
				project,
				"invalid-server",
				"Server entry must be an object",
				`mcp.servers.${name}`,
				name
			);
			continue;
		}
		const merged = merge(
			object(gv) ? gv : {},
			object(pv) ? pv : {},
			source(global),
			source(project)
		);
		const result = resolveServer({
			merged,
			mergedTimeout: projectTimeout ?? globalTimeout ?? DEFAULT_MCP_TIMEOUTS,
			global,
			project,
			projectEntry: pv,
			name,
			diagnostics,
			env,
			workspace,
		});
		if (result) {
			servers[name] = result;
		}
	}
	return { servers, diagnostics };
};
