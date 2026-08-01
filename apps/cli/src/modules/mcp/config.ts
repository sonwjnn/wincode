import path from "node:path";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";

export type McpTimeouts = {
	startup: number;
	catalog: number;
	execution: number;
};
export type McpConfigDiagnostic = {
	serverName?: string;
	scope: "global" | "project";
	code:
		| "duplicate-config"
		| "parse-error"
		| "read-error"
		| "invalid-scope"
		| "invalid-server"
		| "invalid-timeout"
		| "invalid-field"
		| "missing-env"
		| "unsupported-auth"
		| "invalid-url";
	message: string;
	path: string;
};
export type LocalMcpServerConfig = {
	name: string;
	type: "local";
	command: [string, ...string[]];
	cwd?: string;
	environment?: Record<string, string>;
	disabled: boolean;
	timeout: McpTimeouts;
};
export type RemoteMcpServerConfig = {
	name: string;
	type: "remote";
	url: string;
	headers?: Record<string, string>;
	oauth?: false;
	disabled: boolean;
	timeout: McpTimeouts;
};
export type ResolvedMcpServerConfig =
	| LocalMcpServerConfig
	| RemoteMcpServerConfig;
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

export const DEFAULT_MCP_TIMEOUTS = {
	startup: 30_000,
	catalog: 30_000,
	execution: 43_200_000,
} as const satisfies McpTimeouts;
const ENV_PATTERN = /^\{env:([^{}]+)\}$/;
const defaultFs = {
	readFile: (path: string) => globalThis.Bun.file(path).text(),
};
const isNotFound = (error: unknown): boolean =>
	isObject(error) && error.code === "ENOENT";
const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const ownObject = (value: Record<string, unknown>): Record<string, unknown> => {
	const result = Object.create(null) as Record<string, unknown>;
	for (const key of Object.keys(value)) {
		const child = value[key];
		result[key] = isObject(child) ? ownObject(child) : child;
	}
	return result;
};
const validPositive = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value > 0;
const add = (
	diagnostics: McpConfigDiagnostic[],
	scope: "global" | "project",
	code: McpConfigDiagnostic["code"],
	message: string,
	path: string,
	serverName?: string
) =>
	diagnostics.push({
		scope,
		code,
		message,
		path,
		...(serverName ? { serverName } : {}),
	});

type ScopeData = {
	value: Record<string, unknown>;
	path: string;
	scope: "global" | "project";
};
const readScope = async (
	root: string,
	scope: ScopeData["scope"],
	fs: { readFile(path: string): Promise<string> },
	diagnostics: McpConfigDiagnostic[]
): Promise<ScopeData> => {
	const json = path.join(root, "opencode.json");
	const jsonc = path.join(root, "opencode.jsonc");
	let selectedPath = json;
	let source: string;
	try {
		source = await fs.readFile(jsonc);
		selectedPath = jsonc;
	} catch (error) {
		if (!isNotFound(error)) {
			add(
				diagnostics,
				scope,
				"read-error",
				"Could not read config file",
				jsonc
			);
			return { value: {}, path: jsonc, scope };
		}
		try {
			source = await fs.readFile(json);
		} catch (error) {
			if (!isNotFound(error)) {
				add(
					diagnostics,
					scope,
					"read-error",
					"Could not read config file",
					json
				);
			}
			return { value: {}, path: json, scope };
		}
	}
	try {
		await fs.readFile(selectedPath === jsonc ? json : jsonc);
		add(
			diagnostics,
			scope,
			"duplicate-config",
			`Ignored duplicate config ${selectedPath === jsonc ? json : jsonc}`,
			selectedPath
		);
	} catch (error) {
		if (!isNotFound(error)) {
			add(
				diagnostics,
				scope,
				"read-error",
				"Could not inspect duplicate config",
				selectedPath === jsonc ? json : jsonc
			);
		}
		// Alternate config absent.
	}
	try {
		const errors: ParseError[] = [];
		const value = parseJsonc(source, errors, { allowTrailingComma: true });
		if (errors.length || !isObject(value)) {
			throw new Error("invalid");
		}
		return { value: ownObject(value), path: selectedPath, scope };
	} catch {
		add(
			diagnostics,
			scope,
			"parse-error",
			`Could not parse ${selectedPath}`,
			selectedPath
		);
		return { value: {}, path: selectedPath, scope };
	}
};

const merge = (
	base: Record<string, unknown>,
	overlay: Record<string, unknown>
) => {
	const result = { ...base, ...overlay };
	for (const key of ["headers", "environment", "timeout"]) {
		if (isObject(base[key]) && isObject(overlay[key])) {
			result[key] = { ...base[key], ...overlay[key] };
		}
	}
	return result;
};
const resolveString = (
	value: string,
	env: Record<string, string | undefined>,
	diagnostics: McpConfigDiagnostic[],
	scope: ScopeData,
	name: string,
	path: string
): string | undefined => {
	const match = ENV_PATTERN.exec(value);
	if (!match) {
		return value;
	}
	const variable = match[1];
	const resolved =
		variable && Object.hasOwn(env, variable) ? env[variable] : undefined;
	if (typeof resolved !== "string") {
		add(
			diagnostics,
			scope.scope,
			"missing-env",
			`Missing environment variable ${variable} for server ${name}`,
			path,
			name
		);
		return;
	}
	return resolved;
};
const timeoutValue = (
	value: unknown,
	fallback: McpTimeouts,
	diagnostics: McpConfigDiagnostic[],
	scope: ScopeData,
	name?: string
): McpTimeouts | undefined => {
	if (value === undefined) {
		return fallback;
	}
	if (!isObject(value)) {
		add(
			diagnostics,
			scope.scope,
			"invalid-timeout",
			"Timeout must be object",
			`${scope.path}:mcp.timeout`,
			name
		);
		return;
	}
	const result = { ...fallback };
	for (const phase of ["startup", "catalog", "execution"] as const) {
		if (value[phase] !== undefined) {
			if (!validPositive(value[phase])) {
				add(
					diagnostics,
					scope.scope,
					"invalid-timeout",
					`Invalid ${phase} timeout`,
					`${scope.path}:mcp.timeout.${phase}`,
					name
				);
				return;
			}
			result[phase] = value[phase];
		}
	}
	for (const key of Object.keys(value)) {
		if (!["startup", "catalog", "execution"].includes(key)) {
			add(
				diagnostics,
				scope.scope,
				"invalid-timeout",
				"Unknown timeout phase",
				`${scope.path}:mcp.timeout.${key}`,
				name
			);
			return;
		}
	}
	return result;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: configuration validation must isolate each server
export async function loadMcpConfig(
	input: McpConfigInput
): Promise<McpConfigResult> {
	const diagnostics: McpConfigDiagnostic[] = [];
	const fs = input.fs ?? defaultFs;
	const [global, project] = await Promise.all([
		readScope(input.globalRoot, "global", fs, diagnostics),
		readScope(input.workspace, "project", fs, diagnostics),
	]);
	const readMcp = (scope: ScopeData): Record<string, unknown> => {
		if (scope.value.mcp === undefined) {
			return {};
		}
		if (!isObject(scope.value.mcp)) {
			add(
				diagnostics,
				scope.scope,
				"invalid-scope",
				"mcp must be object",
				`${scope.path}:mcp`
			);
			return {};
		}
		return scope.value.mcp;
	};
	const readServers = (scope: ScopeData, mcp: Record<string, unknown>) => {
		if (mcp.servers === undefined) {
			return {};
		}
		if (!isObject(mcp.servers)) {
			add(
				diagnostics,
				scope.scope,
				"invalid-scope",
				"mcp.servers must be object",
				`${scope.path}:mcp.servers`
			);
			return {};
		}
		return mcp.servers;
	};
	const gm = readMcp(global);
	const pm = readMcp(project);
	const gs = readServers(global, gm);
	const ps = readServers(project, pm);
	const globalTimeout = timeoutValue(
		gm.timeout,
		DEFAULT_MCP_TIMEOUTS,
		diagnostics,
		global
	);
	const projectTimeout = timeoutValue(
		pm.timeout,
		globalTimeout ?? DEFAULT_MCP_TIMEOUTS,
		diagnostics,
		project
	);
	const servers: Record<string, ResolvedMcpServerConfig> = {};
	for (const name of new Set([...Object.keys(gs), ...Object.keys(ps)])) {
		const globalEntry = gs[name];
		const projectEntry = ps[name];
		const hasGlobalEntry = globalEntry !== undefined;
		const hasProjectEntry = projectEntry !== undefined;
		const globalValid = !hasGlobalEntry || isObject(globalEntry);
		const projectValid = !hasProjectEntry || isObject(projectEntry);
		if (!globalValid) {
			add(
				diagnostics,
				global.scope,
				"invalid-server",
				"Server entry must be an object",
				`${global.path}:mcp.servers.${name}`,
				name
			);
		}
		if (!projectValid) {
			add(
				diagnostics,
				project.scope,
				"invalid-server",
				"Server entry must be an object",
				`${project.path}:mcp.servers.${name}`,
				name
			);
			continue;
		}
		const gv = globalValid ? (globalEntry ?? {}) : {};
		const pv = projectValid ? (projectEntry ?? {}) : {};
		const raw = merge(gv, pv);
		const scope = Object.keys(pv).length ? project : global;
		const timeout = timeoutValue(
			raw.timeout,
			projectTimeout ?? globalTimeout ?? DEFAULT_MCP_TIMEOUTS,
			diagnostics,
			scope,
			name
		);
		if (!timeout) {
			continue;
		}
		if (
			typeof raw.disabled !== "undefined" &&
			typeof raw.disabled !== "boolean"
		) {
			add(
				diagnostics,
				scope.scope,
				"invalid-field",
				"disabled must be boolean",
				`${scope.path}:mcp.servers.${name}.disabled`,
				name
			);
			continue;
		}
		if (raw.type !== "local" && raw.type !== "remote") {
			add(
				diagnostics,
				scope.scope,
				"invalid-server",
				"Server type must be local or remote",
				`${scope.path}:mcp.servers.${name}.type`,
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
				add(
					diagnostics,
					scope.scope,
					"invalid-server",
					"Invalid local command",
					`${scope.path}:mcp.servers.${name}.command`,
					name
				);
				continue;
			}
			if (raw.cwd !== undefined && typeof raw.cwd !== "string") {
				add(
					diagnostics,
					scope.scope,
					"invalid-field",
					"cwd must be string",
					`${scope.path}:mcp.servers.${name}.cwd`,
					name
				);
				continue;
			}
			const env: Record<string, string> = {};
			if (raw.environment !== undefined && !isObject(raw.environment)) {
				add(
					diagnostics,
					scope.scope,
					"invalid-field",
					"environment must be object",
					`${scope.path}:mcp.servers.${name}.environment`,
					name
				);
				continue;
			}
			let bad = false;
			for (const [key, value] of Object.entries(
				(raw.environment as Record<string, unknown>) ?? {}
			)) {
				if (typeof value === "string") {
					const resolved = resolveString(
						value,
						input.env,
						diagnostics,
						scope,
						name,
						`${scope.path}:mcp.servers.${name}.environment.${key}`
					);
					if (resolved === undefined) {
						bad = true;
					} else {
						env[key] = resolved;
					}
				} else {
					bad = true;
					add(
						diagnostics,
						scope.scope,
						"invalid-field",
						"environment values must be strings",
						`${scope.path}:mcp.servers.${name}.environment.${key}`,
						name
					);
				}
			}
			if (bad) {
				continue;
			}
			servers[name] = {
				name,
				type: "local",
				command: raw.command as [string, ...string[]],
				...(raw.cwd
					? {
							cwd:
								path.isAbsolute(raw.cwd) || path.win32.isAbsolute(raw.cwd)
									? raw.cwd
									: path.resolve(input.workspace, raw.cwd),
						}
					: {}),
				...(Object.keys(env).length ? { environment: env } : {}),
				disabled: raw.disabled === true,
				timeout,
			};
			continue;
		}
		if (raw.oauth !== undefined && raw.oauth !== false) {
			add(
				diagnostics,
				scope.scope,
				"unsupported-auth",
				"OAuth configuration is unsupported",
				`${scope.path}:mcp.servers.${name}.oauth`,
				name
			);
			continue;
		}
		let url: URL;
		try {
			if (typeof raw.url !== "string") {
				throw new Error("URL is not a string");
			}
			url = new URL(raw.url);
			if (
				!(
					["http:", "https:"].includes(url.protocol.toLowerCase()) &&
					url.hostname
				)
			) {
				throw new Error("URL must use HTTP or HTTPS and include hostname");
			}
		} catch {
			add(
				diagnostics,
				scope.scope,
				"invalid-url",
				"URL must be absolute http or https URL",
				`${scope.path}:mcp.servers.${name}.url`,
				name
			);
			continue;
		}
		const headers: Record<string, string> = {};
		if (raw.headers !== undefined && !isObject(raw.headers)) {
			add(
				diagnostics,
				scope.scope,
				"invalid-field",
				"headers must be object",
				`${scope.path}:mcp.servers.${name}.headers`,
				name
			);
			continue;
		}
		let bad = false;
		for (const [key, value] of Object.entries(
			(raw.headers as Record<string, unknown>) ?? {}
		)) {
			if (typeof value === "string") {
				const resolved = resolveString(
					value,
					input.env,
					diagnostics,
					scope,
					name,
					`${scope.path}:mcp.servers.${name}.headers.${key}`
				);
				if (resolved === undefined) {
					bad = true;
				} else {
					headers[key] = resolved;
				}
			} else {
				bad = true;
				add(
					diagnostics,
					scope.scope,
					"invalid-field",
					"header values must be strings",
					`${scope.path}:mcp.servers.${name}.headers.${key}`,
					name
				);
			}
		}
		if (bad) {
			continue;
		}
		servers[name] = {
			name,
			type: "remote",
			url: url.toString(),
			...(Object.keys(headers).length ? { headers } : {}),
			...(raw.oauth === false ? { oauth: false } : {}),
			disabled: raw.disabled === true,
			timeout,
		};
	}
	return { servers, diagnostics };
}
