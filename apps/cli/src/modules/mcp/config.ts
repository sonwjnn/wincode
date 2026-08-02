import path from "node:path";
import { type Diagnostic, readScope, type ScopeData } from "./config/discovery";
import { merge, type Source } from "./config/merge";
import {
	DEFAULT_MCP_TIMEOUTS,
	type McpTimeouts,
	type ResolvedMcpServerConfig,
	resolvedServerSchema,
} from "./config/schema";
const ENV_PATTERN = /^\{env:([^{}]+)\}$/;

export type {
	LocalMcpServerConfig,
	McpTimeouts,
	RemoteMcpServerConfig,
	ResolvedMcpServerConfig,
} from "./config/schema";
export { DEFAULT_MCP_TIMEOUTS } from "./config/schema";
export type McpConfigDiagnostic = Diagnostic;
export type McpConfigInput = {
	workspace: string;
	globalRoot: string;
	env: Record<string, string | undefined>;
	fs?: { readFile(path: string): Promise<string> };
};
export type McpConfigResult = {
	servers: Record<string, ResolvedMcpServerConfig>;
	diagnostics: McpConfigDiagnostic[];
};
const object = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const source = (scope: ScopeData): Source => ({
	scope: scope.scope,
	path: scope.path,
});
const diag = (
	out: Diagnostic[],
	scope: ScopeData,
	code: Diagnostic["code"],
	message: string,
	suffix: string,
	name?: string
) =>
	out.push({
		scope: scope.scope,
		code,
		message,
		path: `${scope.path}:${suffix}`,
		...(name ? { serverName: name } : {}),
	});
const resolve = (
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
		diag(
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
const readSection = (scope: ScopeData, out: Diagnostic[]) => {
	const mcp = scope.value.mcp;
	if (mcp === undefined) {
		return {};
	}
	if (!object(mcp)) {
		diag(out, scope, "invalid-scope", "mcp must be object", "mcp");
		return {};
	}
	const servers = mcp.servers;
	if (servers === undefined) {
		return {};
	}
	if (!object(servers)) {
		diag(
			out,
			scope,
			"invalid-scope",
			"mcp.servers must be object",
			"mcp.servers"
		);
		return {};
	}
	return servers;
};
const timeout = (
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
		diag(
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
		if (
			value[phase] !== undefined &&
			(typeof value[phase] !== "number" ||
				!Number.isInteger(value[phase]) ||
				value[phase] <= 0)
		) {
			diag(
				out,
				scope,
				"invalid-timeout",
				`Invalid ${phase} timeout`,
				`mcp.timeout.${phase}`,
				name
			);
			return;
		}
		if (typeof value[phase] === "number") {
			result[phase] = value[phase];
		}
	}
	return result;
};
export async function loadMcpConfig(
	input: McpConfigInput
): Promise<McpConfigResult> {
	const diagnostics: Diagnostic[] = [];
	const fs = input.fs ?? {
		readFile: (file: string) => globalThis.Bun.file(file).text(),
	};
	const [global, project] = await Promise.all([
		readScope(input.globalRoot, "global", fs, diagnostics),
		readScope(input.workspace, "project", fs, diagnostics),
	]);
	const gs = readSection(global, diagnostics);
	const ps = readSection(project, diagnostics);
	const servers: Record<string, ResolvedMcpServerConfig> = {};
	const globalMcp: Record<string, unknown> = object(global.value.mcp)
		? global.value.mcp
		: {};
	const projectMcp: Record<string, unknown> = object(project.value.mcp)
		? project.value.mcp
		: {};
	const globalTimeout = timeout(
		globalMcp.timeout,
		DEFAULT_MCP_TIMEOUTS,
		diagnostics,
		global
	);
	const projectTimeout = timeout(
		projectMcp.timeout,
		globalTimeout ?? DEFAULT_MCP_TIMEOUTS,
		diagnostics,
		project
	);
	for (const name of new Set([...Object.keys(gs), ...Object.keys(ps)])) {
		const gv = gs[name];
		const pv = ps[name];
		if (gv !== undefined && !object(gv)) {
			diag(
				diagnostics,
				global,
				"invalid-server",
				"Server entry must be an object",
				`mcp.servers.${name}`,
				name
			);
		}
		if (pv !== undefined && !object(pv)) {
			diag(
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
		const raw = merged.value;
		const owner = (key: string): ScopeData =>
			merged.sources.get(key)?.scope === "project" ? project : global;
		const scope = owner("type");
		const t = timeout(
			raw.timeout,
			projectTimeout ?? globalTimeout ?? DEFAULT_MCP_TIMEOUTS,
			diagnostics,
			owner("timeout"),
			name
		);
		if (!t) {
			continue;
		}
		if (raw.type !== "local" && raw.type !== "remote") {
			diag(
				diagnostics,
				scope,
				"invalid-server",
				"Server type must be local or remote",
				`mcp.servers.${name}.type`,
				name
			);
			continue;
		}
		const base = {
			name,
			type: raw.type,
			disabled: raw.disabled === true,
			timeout: t,
		};
		if (raw.disabled !== undefined && typeof raw.disabled !== "boolean") {
			diag(
				diagnostics,
				owner("disabled"),
				"invalid-field",
				"disabled must be boolean",
				`mcp.servers.${name}.disabled`,
				name
			);
			continue;
		}
		if (raw.type === "local") {
			if (
				!Array.isArray(raw.command) ||
				raw.command.length === 0 ||
				raw.command.some((v) => typeof v !== "string")
			) {
				diag(
					diagnostics,
					scope,
					"invalid-server",
					"Invalid local command",
					`mcp.servers.${name}.command`,
					name
				);
				continue;
			}
			const command = [
				String(raw.command[0]),
				...raw.command.slice(1).map(String),
			] as [string, ...string[]];
			const environment: Record<string, string> = {};
			let badEnvironment = false;
			for (const [key, value] of Object.entries(
				object(raw.environment) ? raw.environment : {}
			)) {
				const resolved = resolve(
					value,
					input.env,
					diagnostics,
					owner(`environment.${key}`),
					name,
					`mcp.servers.${name}.environment.${key}`
				);
				if (resolved === undefined) {
					badEnvironment = true;
					continue;
				}
				environment[key] = resolved;
			}
			if (badEnvironment) {
				continue;
			}
			const cwd = typeof raw.cwd === "string" ? raw.cwd : undefined;
			const result = {
				...base,
				type: "local" as const,
				command,
				...(cwd
					? {
							cwd:
								path.isAbsolute(cwd) || path.win32.isAbsolute(cwd)
									? cwd
									: path.resolve(input.workspace, cwd),
						}
					: {}),
				...(Object.keys(environment).length ? { environment } : {}),
			};
			const parsed = resolvedServerSchema.safeParse(result);
			if (parsed.success) {
				servers[name] = parsed.data;
			}
			continue;
		}
		let url: URL;
		try {
			url = new URL(String(raw.url));
			if (!(["http:", "https:"].includes(url.protocol) && url.hostname)) {
				throw new Error();
			}
		} catch {
			diag(
				diagnostics,
				owner("url"),
				"invalid-url",
				"URL must be absolute http or https URL",
				`mcp.servers.${name}.url`,
				name
			);
			continue;
		}
		if (raw.oauth !== undefined && raw.oauth !== false) {
			diag(
				diagnostics,
				owner("oauth"),
				"unsupported-auth",
				"OAuth configuration is unsupported",
				`mcp.servers.${name}.oauth`,
				name
			);
			continue;
		}
		const headers: Record<string, string> = {};
		let badHeaders = false;
		for (const [key, value] of Object.entries(
			object(raw.headers) ? raw.headers : {}
		)) {
			const resolved = resolve(
				value,
				input.env,
				diagnostics,
				owner(`headers.${key}`),
				name,
				`mcp.servers.${name}.headers.${key}`
			);
			if (resolved === undefined) {
				badHeaders = true;
				continue;
			}
			headers[key] = resolved;
		}
		if (badHeaders) {
			continue;
		}
		const result = {
			...base,
			type: "remote" as const,
			url: url.toString(),
			...(Object.keys(headers).length ? { headers } : {}),
			...(raw.oauth === false ? { oauth: false as const } : {}),
		};
		const parsed = resolvedServerSchema.safeParse(result);
		if (parsed.success) {
			servers[name] = parsed.data;
		}
	}
	return { servers, diagnostics };
}
