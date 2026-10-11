import * as path from "node:path";
import { isPlainObject, isUndefined, omitUndefined } from "@wincode/utils";
import type { ZodError } from "zod";
import {
	DEFAULT_MCP_TIMEOUTS,
	type McpExposure,
	type McpTimeouts,
	mcpServerNameSchema,
	type RawMcpServerConfig,
	type ResolvedMcpServerConfig,
	rawServerSchema,
	resolvedServerSchema,
} from "./schema";

const VARIABLE_PATTERN =
	/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$env:([A-Za-z_][A-Za-z0-9_]*)|\$([A-Za-z_][A-Za-z0-9_]*)|\$\$|\$!/gu;
const PROJECT_OVERLAY_FIELDS = new Set(["enabled", "exposure", "toolExposure"]);

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
	| "unsupported-auth"
	| "command-failed"
	| "unsupported-transport"
	| "unsupported-exposure";

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
	serverSources?: Readonly<Record<string, McpConfigOrigin>>;
	servers: Readonly<Record<string, ResolvedMcpServerConfig>>;
}>;

export type InvalidMcpServerConfig = Readonly<{
	error: string;
	name: string;
	transport: "local" | "remote";
}>;

type EffectiveServer = Readonly<{
	raw: Readonly<Record<string, unknown>>;
	source: McpConfigSource;
}>;

type ResolutionContext = Readonly<{
	diagnostics: McpConfigDiagnostic[];
	env: Readonly<Record<string, string | undefined>>;
	name: string;
	commandOutputs: Map<string, string>;
	source: McpConfigSource;
	workspace: string;
}>;

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

const serverPath = (name: string, field: readonly string[] = []): string =>
	["mcpServers", name, ...field].join(".");

const addDiagnostic = (
	diagnostics: McpConfigDiagnostic[],
	origin: McpConfigOrigin,
	code: McpConfigDiagnosticCode,
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

const mergePatch = (
	base: Readonly<Record<string, unknown>>,
	patch: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> => {
	const merged: Record<string, unknown> = Object.assign(
		Object.create(null),
		base
	);
	for (const [key, incoming] of Object.entries(patch)) {
		const current = merged[key];
		merged[key] =
			isPlainObject(current) && isPlainObject(incoming)
				? mergePatch(current, incoming)
				: incoming;
	}
	return merged;
};

const isTransportDefinition = (
	server: Readonly<Record<string, unknown>>
): boolean => Object.hasOwn(server, "command") || Object.hasOwn(server, "url");

const readServerEntries = (
	source: McpConfigSource,
	diagnostics: McpConfigDiagnostic[]
): Readonly<Record<string, unknown>> | undefined => {
	const candidate = source.document.mcpServers;
	if (isUndefined(candidate)) {
		return;
	}
	if (!isPlainObject(candidate)) {
		addDiagnostic(
			diagnostics,
			source,
			"invalid-scope",
			"mcpServers must be an object",
			"mcpServers"
		);
		return;
	}
	return candidate;
};

const applyGlobalServer = (
	servers: Map<string, EffectiveServer>,
	source: McpConfigSource,
	name: string,
	candidate: unknown,
	diagnostics: McpConfigDiagnostic[]
): void => {
	if (!mcpServerNameSchema.safeParse(name).success) {
		addDiagnostic(
			diagnostics,
			source,
			"invalid-server",
			"Server names may contain only letters, digits, underscores, and hyphens.",
			serverPath(name),
			name
		);
		return;
	}
	if (!isPlainObject(candidate)) {
		addDiagnostic(
			diagnostics,
			source,
			"invalid-server",
			"Server entry must be an object",
			serverPath(name),
			name
		);
		return;
	}
	const existing = servers.get(name);
	if (source.scope === "plugin") {
		if (existing !== undefined) {
			addDiagnostic(
				diagnostics,
				source,
				"invalid-server",
				"MCP Server registration names must be unique across Plugins.",
				serverPath(name),
				name
			);
			return;
		}
		servers.set(name, { raw: candidate, source });
		return;
	}
	if (existing?.source.scope === "plugin") {
		servers.set(name, {
			raw: isTransportDefinition(candidate)
				? candidate
				: mergePatch(existing.raw, candidate),
			source,
		});
		return;
	}
	servers.set(name, {
		raw: mergePatch(existing?.raw ?? {}, candidate),
		source,
	});
};

const applyProjectServer = (
	servers: Map<string, EffectiveServer>,
	source: McpConfigSource,
	name: string,
	candidate: unknown,
	diagnostics: McpConfigDiagnostic[]
): void => {
	if (
		!(mcpServerNameSchema.safeParse(name).success && isPlainObject(candidate))
	) {
		addDiagnostic(
			diagnostics,
			source,
			"invalid-server",
			"Project MCP server entries require a valid name and object value.",
			serverPath(name),
			name
		);
		return;
	}
	if (isTransportDefinition(candidate)) {
		servers.set(name, { raw: candidate, source });
		return;
	}
	const unsupportedFields = Object.keys(candidate).filter(
		(field) => !PROJECT_OVERLAY_FIELDS.has(field)
	);
	if (unsupportedFields.length > 0) {
		addDiagnostic(
			diagnostics,
			source,
			"invalid-server",
			"Project overlays may set only enabled, exposure, and toolExposure.",
			serverPath(name),
			name
		);
		return;
	}
	const previous = servers.get(name);
	if (previous?.source.scope !== "global") {
		addDiagnostic(
			diagnostics,
			source,
			"invalid-server",
			"A project override requires an existing user server definition.",
			serverPath(name),
			name
		);
		return;
	}
	servers.set(name, {
		raw: mergePatch(previous.raw, candidate),
		source: previous.source,
	});
};

const applyServerEntries = (
	servers: Map<string, EffectiveServer>,
	source: McpConfigSource,
	diagnostics: McpConfigDiagnostic[],
	applyEntry: (
		servers: Map<string, EffectiveServer>,
		source: McpConfigSource,
		name: string,
		candidate: unknown,
		diagnostics: McpConfigDiagnostic[]
	) => void
): void => {
	const entries = readServerEntries(source, diagnostics);
	if (entries === undefined) {
		return;
	}
	for (const [name, candidate] of Object.entries(entries)) {
		applyEntry(servers, source, name, candidate, diagnostics);
	}
};

const effectiveServers = (
	snapshot: McpConfigSnapshot,
	diagnostics: McpConfigDiagnostic[]
): ReadonlyMap<string, EffectiveServer> => {
	const servers = new Map<string, EffectiveServer>();
	for (const source of snapshot.sources) {
		if (source.scope !== "project") {
			applyServerEntries(servers, source, diagnostics, applyGlobalServer);
		}
	}
	for (const source of snapshot.sources) {
		if (source.scope === "project") {
			applyServerEntries(servers, source, diagnostics, applyProjectServer);
		}
	}
	return servers;
};

const diagnosticCode = (field: readonly string[]): McpConfigDiagnosticCode => {
	const rootField = field[0] ?? "";
	if (rootField === "timeout") {
		return "invalid-timeout";
	}
	if (rootField === "exposure" || rootField === "toolExposure") {
		return "unsupported-exposure";
	}
	if (rootField === "type" || rootField === "command" || rootField === "url") {
		return "unsupported-transport";
	}
	return "invalid-field";
};

const addSchemaDiagnostics = (
	context: ResolutionContext,
	error: ZodError
): void => {
	for (const issue of error.issues) {
		const fields =
			issue.code === "unrecognized_keys"
				? issue.keys.map((key) => [key])
				: [issue.path.map(String)];
		for (const field of fields) {
			addDiagnostic(
				context.diagnostics,
				context.source,
				diagnosticCode(field),
				issue.message,
				serverPath(context.name, field),
				context.name
			);
		}
	}
};

const runConfigCommand = async (
	command: string,
	context: ResolutionContext,
	field: readonly string[]
): Promise<string | undefined> => {
	const cached = context.commandOutputs.get(command);
	if (cached !== undefined) {
		return cached;
	}
	try {
		if (command.trim().length === 0) {
			throw new Error("empty command");
		}
		const shellCommand =
			process.platform === "win32"
				? [process.env.COMSPEC ?? "cmd.exe", "/d", "/s", "/c", command]
				: ["/bin/sh", "-c", command];
		const commandEnvironment = Object.fromEntries(
			Object.entries({ ...process.env, ...context.env }).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string"
			)
		);
		const child = Bun.spawn(shellCommand, {
			cwd: context.workspace,
			env: commandEnvironment,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			signal: AbortSignal.timeout(10_000),
		});
		try {
			const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
			const decoder = new TextDecoder();
			let output = "";
			let outputBytes = 0;
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				outputBytes += value.byteLength;
				if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
					throw new Error("command output limit exceeded");
				}
				output += decoder.decode(value, { stream: true });
			}
			output += decoder.decode();
			const exitCode = await child.exited;
			if (exitCode !== 0) {
				throw new Error("command exited unsuccessfully");
			}
			const trimmed = output.trim();
			if (trimmed.length === 0) {
				throw new Error("command returned no value");
			}
			context.commandOutputs.set(command, trimmed);
			return trimmed;
		} catch (error) {
			child.kill();
			await child.exited;
			throw error;
		}
	} catch {
		addDiagnostic(
			context.diagnostics,
			context.source,
			"command-failed",
			`Could not resolve command value for server ${context.name}.`,
			serverPath(context.name, field),
			context.name
		);
		return;
	}
};

const resolveString = async (
	value: string,
	context: ResolutionContext,
	field: readonly string[]
): Promise<string | undefined> => {
	if ((field[0] === "env" || field[0] === "headers") && value.startsWith("!")) {
		return runConfigCommand(value.slice(1), context, field);
	}
	let missingVariable: string | undefined;
	const resolved = value.replace(
		VARIABLE_PATTERN,
		(
			match,
			braced: string | undefined,
			envName: string | undefined,
			bare: string | undefined
		) => {
			if (match === "$$") {
				return "$";
			}
			if (match === "$!") {
				return "!";
			}
			const variable = braced ?? envName ?? bare ?? "";
			const replacement = context.env[variable];
			if (replacement === undefined) {
				missingVariable = variable;
				return "";
			}
			return replacement;
		}
	);
	if (missingVariable !== undefined) {
		addDiagnostic(
			context.diagnostics,
			context.source,
			"missing-env",
			`Missing environment variable ${missingVariable} for server ${context.name}`,
			serverPath(context.name, field),
			context.name
		);
		return;
	}
	return resolved;
};

const resolveStringRecord = async (
	value: unknown,
	context: ResolutionContext,
	field: string
): Promise<Record<string, string> | undefined> => {
	if (!isPlainObject(value)) {
		return {};
	}
	const result: Record<string, string> = {};
	for (const [key, candidate] of Object.entries(value)) {
		if (typeof candidate !== "string") {
			continue;
		}
		const commandValue = candidate.startsWith("!");
		const resolved = await resolveString(candidate, context, [field, key]);
		if (resolved === undefined) {
			if (commandValue) {
				continue;
			}
			return;
		}
		result[key] = resolved;
	}
	return result;
};

const homeExpand = (value: string, homeRoot: string): string =>
	value === "~" || value.startsWith(`~${path.sep}`)
		? path.join(homeRoot, value.slice(2))
		: value;

type ResolvedServerBase = Readonly<{
	description: string | undefined;
	disabled: boolean;
	exposure: McpExposure;
	name: string;
	timeout: McpTimeouts;
	toolExposure: Record<string, McpExposure> | undefined;
}>;

const resolvedServerBase = (
	context: ResolutionContext,
	raw: RawMcpServerConfig
): ResolvedServerBase => ({
	description: raw.description,
	disabled: raw.enabled === false,
	exposure: raw.exposure ?? "direct",
	name: context.name,
	timeout: {
		...DEFAULT_MCP_TIMEOUTS,
		...(raw.timeout === undefined
			? {}
			: { execution: Math.round(raw.timeout * 1000) }),
	},
	toolExposure: raw.toolExposure,
});

const resolveLocalServer = async (
	context: ResolutionContext,
	raw: RawMcpServerConfig,
	base: ResolvedServerBase
): Promise<ResolvedMcpServerConfig | undefined> => {
	if (typeof raw.command !== "string") {
		return;
	}
	const environment = await resolveStringRecord(raw.env, context, "env");
	if (environment === undefined) {
		return;
	}
	const homeRoot = context.env.HOME ?? process.env.HOME ?? "";
	const command = await resolveString(raw.command, context, ["command"]);
	const args = await Promise.all(
		(raw.args ?? []).map((arg, index) =>
			resolveString(arg, context, ["args", String(index)])
		)
	);
	let cwd: string | undefined;
	if (raw.cwd !== undefined) {
		const cwdValue = await resolveString(raw.cwd, context, ["cwd"]);
		if (cwdValue === undefined) {
			return;
		}
		const expandedCwd = homeExpand(cwdValue, homeRoot);
		cwd = path.isAbsolute(expandedCwd)
			? expandedCwd
			: path.resolve(context.workspace, expandedCwd);
	}
	if (
		command === undefined ||
		args.some((argument) => argument === undefined)
	) {
		return;
	}
	const parsed = resolvedServerSchema.safeParse({
		...base,
		type: "local" as const,
		command: [
			homeExpand(command, homeRoot),
			...args.map((arg) => homeExpand(arg ?? "", homeRoot)),
		],
		...(cwd === undefined ? {} : { cwd }),
		...(Object.keys(environment).length === 0 ? {} : { environment }),
	});
	if (!parsed.success) {
		addSchemaDiagnostics(context, parsed.error);
		return;
	}
	return parsed.data;
};

const parseHttpUrl = (value: string): URL | undefined => {
	try {
		const url = new URL(value);
		if (url.hostname && ["http:", "https:"].includes(url.protocol)) {
			return url;
		}
	} catch {
		return;
	}
	return;
};

const hasOAuthClientSecret = (
	context: ResolutionContext,
	oauth: unknown
): boolean => {
	if (!(isPlainObject(oauth) && Object.hasOwn(oauth, "clientSecret"))) {
		return false;
	}
	addDiagnostic(
		context.diagnostics,
		context.source,
		"unsupported-auth",
		"MCP configuration cannot provide OAuth client secrets; use the host secret store.",
		serverPath(context.name, ["oauth", "clientSecret"]),
		context.name
	);
	return true;
};

const resolveRemoteServer = async (
	context: ResolutionContext,
	raw: RawMcpServerConfig,
	base: ResolvedServerBase
): Promise<ResolvedMcpServerConfig | undefined> => {
	if (typeof raw.url !== "string") {
		return;
	}
	const resolvedUrl = await resolveString(raw.url, context, ["url"]);
	if (resolvedUrl === undefined) {
		return;
	}
	const url = parseHttpUrl(resolvedUrl);
	if (url === undefined) {
		addDiagnostic(
			context.diagnostics,
			context.source,
			"invalid-url",
			"URL must be absolute http or https URL",
			serverPath(context.name, ["url"]),
			context.name
		);
		return;
	}
	if (hasOAuthClientSecret(context, raw.oauth)) {
		return;
	}
	const headers = await resolveStringRecord(raw.headers, context, "headers");
	if (headers === undefined) {
		return;
	}
	const oauth = raw.oauth;
	const parsed = resolvedServerSchema.safeParse({
		...base,
		type: "remote" as const,
		url: url.toString(),
		...(Object.keys(headers).length === 0 ? {} : { headers }),
		...omitUndefined({ auth: raw.auth, oauth }),
	});
	if (!parsed.success) {
		addSchemaDiagnostics(context, parsed.error);
		return;
	}
	return parsed.data;
};

const resolveServer = async (
	context: ResolutionContext,
	raw: RawMcpServerConfig
): Promise<ResolvedMcpServerConfig | undefined> => {
	const isLocal = typeof raw.command === "string";
	const isRemote = typeof raw.url === "string";
	if (isLocal === isRemote) {
		addDiagnostic(
			context.diagnostics,
			context.source,
			"invalid-server",
			"A server must define exactly one of command or url.",
			serverPath(context.name),
			context.name
		);
		return;
	}
	const typeMismatch =
		(raw.type === "stdio" && !isLocal) ||
		((raw.type === "http" || raw.type === "streamable-http") && !isRemote);
	if (typeMismatch) {
		addDiagnostic(
			context.diagnostics,
			context.source,
			"unsupported-transport",
			"Server type does not match its command or URL transport.",
			serverPath(context.name, ["type"]),
			context.name
		);
		return;
	}
	const base = resolvedServerBase(context, raw);
	if (isLocal) {
		return resolveLocalServer(context, raw, base);
	}
	return resolveRemoteServer(context, raw, base);
};

const malformedServerTransport = (
	value: Readonly<Record<string, unknown>>
): "local" | "remote" =>
	typeof value.command === "string" ? "local" : "remote";

export const resolveServers = async ({
	env,
	snapshot,
	workspace,
}: {
	env: Readonly<Record<string, string | undefined>>;
	snapshot: McpConfigSnapshot;
	workspace: string;
}): Promise<McpConfigResult> => {
	const diagnostics = snapshot.diagnostics.map((diagnostic) => ({
		...diagnostic,
	}));
	const effective = effectiveServers(snapshot, diagnostics);
	const servers: Record<string, ResolvedMcpServerConfig> = {};
	const invalidServers: Record<string, InvalidMcpServerConfig> = {};
	const serverSources: Record<string, McpConfigOrigin> = {};
	for (const [name, { raw, source }] of effective) {
		const context: ResolutionContext = {
			commandOutputs: new Map(),
			diagnostics,
			env,
			name,
			source,
			workspace,
		};
		serverSources[name] = { path: source.path, scope: source.scope };
		const validated = rawServerSchema.safeParse(raw);
		if (!validated.success) {
			addSchemaDiagnostics(context, validated.error);
			invalidServers[name] = {
				error:
					diagnostics.find((diagnostic) => diagnostic.serverName === name)
						?.message ?? "Invalid MCP server configuration",
				name,
				transport: malformedServerTransport(raw),
			};
			continue;
		}
		const resolved = await resolveServer(context, validated.data);
		if (resolved === undefined) {
			invalidServers[name] = {
				error:
					diagnostics.find((diagnostic) => diagnostic.serverName === name)
						?.message ?? "Invalid MCP server configuration",
				name,
				transport: malformedServerTransport(raw),
			};
		} else {
			servers[name] = resolved;
		}
	}
	return { diagnostics, invalidServers, serverSources, servers };
};
