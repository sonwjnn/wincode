import { type ParseError, parse as parseJsonc } from "jsonc-parser";

export type LocalMcpServer = {
	name: string;
	type: "local";
	command: [string, ...string[]];
	cwd?: string;
	environment?: Record<string, string>;
	disabled: boolean;
	timeout: number;
};
export type RemoteMcpServer = {
	name: string;
	type: "remote";
	url: string;
	headers?: Record<string, string>;
	oauth?: false;
	disabled: boolean;
	timeout: number;
};
export type McpServer = LocalMcpServer | RemoteMcpServer;
export type McpConfigInput = {
	workspace: string;
	globalRoot: string;
	env: Record<string, string | undefined>;
	fs?: { readFile(path: string): Promise<string> };
};
export type McpConfigResult = { servers: McpServer[]; diagnostics: string[] };

const DEFAULT_TIMEOUT = 30_000;
const ENV_PATTERN = /^\{env:([^{}]+)\}$/;
const HTTP_URL_PATTERN = /^https?:\/\//;
const defaultFs = {
	readFile: (path: string) => globalThis.Bun.file(path).text(),
};
const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isCommand = (value: unknown): value is [string, ...string[]] =>
	Array.isArray(value) &&
	value.length > 0 &&
	value.every((item) => typeof item === "string");

const readScope = async (
	root: string,
	fs: { readFile(path: string): Promise<string> },
	diagnostics: string[]
) => {
	const json = `${root}/opencode.json`;
	const jsonc = `${root}/opencode.jsonc`;
	let source: string | undefined;
	try {
		source = await fs.readFile(jsonc);
	} catch {
		try {
			source = await fs.readFile(json);
		} catch {
			return {};
		}
	}
	if (source !== undefined) {
		try {
			await fs.readFile(json);
			diagnostics.push(`Ignored duplicate config ${json}`);
		} catch {
			/* absent */
		}
	}
	try {
		const errors: ParseError[] = [];
		const value: unknown = parseJsonc(source, errors);
		if (errors.length > 0 || !isObject(value)) {
			throw new Error("invalid JSONC");
		}
		return value;
	} catch {
		diagnostics.push(`Could not parse ${jsonc}`);
		return {};
	}
};

const merge = (
	base: Record<string, unknown>,
	overlay: Record<string, unknown>
) => {
	const result: Record<string, unknown> = { ...base, ...overlay };
	for (const key of ["headers", "environment"]) {
		if (isObject(base[key]) && isObject(overlay[key])) {
			result[key] = { ...base[key], ...overlay[key] };
		}
	}
	return result;
};
const resolve = (
	value: string,
	env: Record<string, string | undefined>,
	name: string,
	diagnostics: string[]
) => {
	const match = ENV_PATTERN.exec(value);
	if (!match) {
		return value;
	}
	const variable = match[1];
	if (variable === undefined) {
		return value;
	}
	const resolved = env[variable];
	if (resolved === undefined) {
		diagnostics.push(
			`MCP server ${name} unavailable: missing environment variable ${variable}`
		);
		return;
	}
	return resolved;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: validation must isolate each server.
export async function loadMcpConfig(
	input: McpConfigInput
): Promise<McpConfigResult> {
	const diagnostics: string[] = [];
	const fs = input.fs ?? defaultFs;
	const [global, project] = await Promise.all([
		readScope(input.globalRoot, fs, diagnostics),
		readScope(input.workspace, fs, diagnostics),
	]);
	const globalMcp = isObject(global.mcp) ? global.mcp : {};
	const projectMcp = isObject(project.mcp) ? project.mcp : {};
	const globalServers = isObject(globalMcp.servers) ? globalMcp.servers : {};
	const projectServers = isObject(projectMcp.servers) ? projectMcp.servers : {};
	const names = new Set([
		...Object.keys(globalServers),
		...Object.keys(projectServers),
	]);
	const globalTimeout =
		typeof globalMcp.timeout === "number" &&
		Number.isInteger(globalMcp.timeout) &&
		globalMcp.timeout > 0
			? globalMcp.timeout
			: DEFAULT_TIMEOUT;
	const servers: McpServer[] = [];
	for (const name of names) {
		const raw = merge(
			isObject(globalServers[name]) ? globalServers[name] : {},
			isObject(projectServers[name]) ? projectServers[name] : {}
		);
		const timeout =
			typeof raw.timeout === "number" &&
			Number.isInteger(raw.timeout) &&
			raw.timeout > 0
				? raw.timeout
				: globalTimeout;
		if (
			raw.timeout !== undefined &&
			timeout === globalTimeout &&
			raw.timeout !== globalTimeout
		) {
			diagnostics.push(`MCP server ${name} has invalid timeout`);
		}
		if (raw.type === "local" && isCommand(raw.command)) {
			const environment: Record<string, string> = {};
			let unavailable = false;
			if (isObject(raw.environment)) {
				for (const [key, value] of Object.entries(raw.environment)) {
					if (typeof value === "string") {
						const resolved = resolve(value, input.env, name, diagnostics);
						if (resolved === undefined) {
							unavailable = true;
						} else {
							environment[key] = resolved;
						}
					}
				}
			}
			if (!unavailable) {
				servers.push({
					name,
					type: "local",
					command: raw.command,
					...(typeof raw.cwd === "string"
						? {
								cwd: raw.cwd.startsWith("/")
									? raw.cwd
									: `${input.workspace}/${raw.cwd}`,
							}
						: {}),
					...(Object.keys(environment).length > 0 ? { environment } : {}),
					disabled: raw.disabled === true,
					timeout,
				});
			}
			continue;
		}
		if (
			raw.type === "remote" &&
			typeof raw.url === "string" &&
			HTTP_URL_PATTERN.test(raw.url) &&
			(raw.oauth === undefined || raw.oauth === false)
		) {
			const headers: Record<string, string> = {};
			let unavailable = false;
			if (isObject(raw.headers)) {
				for (const [key, value] of Object.entries(raw.headers)) {
					if (typeof value === "string") {
						const resolved = resolve(value, input.env, name, diagnostics);
						if (resolved === undefined) {
							unavailable = true;
						} else {
							headers[key] = resolved;
						}
					}
				}
			}
			if (!unavailable) {
				servers.push({
					name,
					type: "remote",
					url: raw.url,
					...(Object.keys(headers).length > 0 ? { headers } : {}),
					...(raw.oauth === false ? { oauth: false } : {}),
					disabled: raw.disabled === true,
					timeout,
				});
			}
			continue;
		}
		diagnostics.push(`MCP server ${name} is invalid or unavailable`);
	}
	return { servers, diagnostics };
}
