import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import {
	createMcpManagement,
	type McpManagementApi,
	type McpManagementOAuthOperations,
} from "@wincode/mcp";
import open from "open";
import { createPluginSecretStore } from "@/modules/plugins/plugin-secret-store";
import { resolveProjectTrust } from "@/modules/project-trust/project-trust";
import { resolveWorkspaceRoot } from "@/modules/tools";
import type { ConfigStore } from "@/shared/config/config-store";
import { createConfigStore } from "@/shared/config/config-store";
import {
	resolveUserDataDir,
	resolveUserWincodeDir,
} from "@/shared/paths/user-data-dir";
import type { TextWriter } from "./modes/types";

const HELP_TEXT = [
	"Usage: wincode mcp <add|remove|list|login|logout> [options]",
	"",
	"Commands:",
	"  add <name> --url <url> [--header KEY=VALUE]... [--auth oauth]",
	"  add <name> --command <executable> [--arg VALUE]... [--cwd PATH] [--env KEY=VALUE]...",
	"  remove <name> [--scope user|project]",
	"  list [--json]",
	"  login <name>",
	"  logout <name>",
	"",
	"Options:",
	"  --scope user|project  Select the config scope (default: user)",
	"  --trust-project       Explicitly trust project config for this command",
].join("\n");

const outputLine = (writer: TextWriter, text: string): void =>
	writer.write(`${text}\n`);

export type McpCliOptions = Readonly<{
	configStore?: ConfigStore;
	homeRoot?: string;
	openAuthorizationUrl?: (url: URL) => Promise<void>;
	oauthOperations?: McpManagementOAuthOperations;
	projectTrustDir?: string;
	readRedirectUrl?: (callback: Promise<URL>) => Promise<URL>;
	trustedProjectRoots?: readonly string[];
	userDataDir?: string;
}>;

export type McpCliIo = Readonly<{
	stderr: TextWriter;
	stdinIsTTY: boolean;
	stdout: TextWriter;
}>;

type Scope = "global" | "project";
type McpCliRuntime = Readonly<{
	configStore: ConfigStore;
	trustedProjectRoots: readonly string[];
	workspace: string;
}>;
type AddOptions = {
	args: string[];
	auth?: "oauth";
	command?: string;
	cwd?: string;
	env: Record<string, string>;
	headers: Record<string, string>;
	scope: Scope;
	url?: string;
};

const readScope = (value: string): Scope => {
	if (value === "user") {
		return "global";
	}
	if (value === "project") {
		return "project";
	}
	throw new Error(
		`Unknown MCP config scope '${value}'. Expected user or project.`
	);
};

const parseKeyValue = (
	value: string,
	option: string
): readonly [string, string] => {
	const separator = value.indexOf("=");
	if (separator < 1) {
		throw new Error(`${option} expects KEY=VALUE.`);
	}
	return [value.slice(0, separator), value.slice(separator + 1)];
};

const nextValue = (
	args: readonly string[],
	index: number,
	option: string
): Readonly<{ index: number; value: string }> => {
	const value = args[index + 1];
	if (value === undefined || value.startsWith("--")) {
		throw new Error(`${option} requires a value.`);
	}
	return { index: index + 1, value };
};

const parseScopeAndTrust = (
	args: readonly string[],
	initialScope: Scope = "global"
): Readonly<{
	explicitScope: boolean;
	index: number;
	scope: Scope;
	trustProject: boolean;
}> => {
	let explicitScope = false;
	let scope = initialScope;
	let trustProject = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === undefined) {
			continue;
		}
		if (argument === "--trust-project") {
			trustProject = true;
			continue;
		}
		if (argument === "--scope") {
			const next = nextValue(args, index, argument);
			index = next.index;
			scope = readScope(next.value);
			explicitScope = true;
			continue;
		}
		if (argument.startsWith("--scope=")) {
			scope = readScope(argument.slice("--scope=".length));
			explicitScope = true;
		}
	}
	return { explicitScope, index: args.length, scope, trustProject };
};

const parseScopeOption = (
	args: readonly string[],
	index: number,
	argument: string,
	result: AddOptions
): number | undefined => {
	if (argument === "--scope") {
		const next = nextValue(args, index, argument);
		result.scope = readScope(next.value);
		return next.index;
	}
	if (argument.startsWith("--scope=")) {
		result.scope = readScope(argument.slice("--scope=".length));
		return index;
	}
	return;
};

const parseTransportOption = (
	args: readonly string[],
	index: number,
	argument: string,
	result: AddOptions
): number | undefined => {
	if (
		argument !== "--url" &&
		argument !== "--command" &&
		argument !== "--cwd"
	) {
		return;
	}
	const next = nextValue(args, index, argument);
	switch (argument) {
		case "--url":
			result.url = next.value;
			break;
		case "--command":
			result.command = next.value;
			break;
		default:
			result.cwd = next.value;
	}
	return next.index;
};

const parseCollectionOption = (
	args: readonly string[],
	index: number,
	argument: string,
	result: AddOptions
): number | undefined => {
	if (argument === "--arg") {
		const next = nextValue(args, index, argument);
		result.args.push(next.value);
		return next.index;
	}
	if (argument !== "--env" && argument !== "--header") {
		return;
	}
	const next = nextValue(args, index, argument);
	const [key, value] = parseKeyValue(next.value, argument);
	if (argument === "--env") {
		result.env[key] = value;
	} else {
		result.headers[key] = value;
	}
	return next.index;
};

const parseAuthOption = (
	args: readonly string[],
	index: number,
	argument: string,
	result: AddOptions
): number | undefined => {
	if (argument === "--oauth") {
		result.auth = "oauth";
		return index;
	}
	if (argument !== "--auth") {
		return;
	}
	const next = nextValue(args, index, argument);
	if (next.value !== "oauth") {
		throw new Error("MCP supports only --auth oauth.");
	}
	result.auth = "oauth";
	return next.index;
};

const parseAddOptions = (
	args: readonly string[],
	initialScope: Scope
): AddOptions => {
	const result: AddOptions = {
		args: [],
		env: {},
		headers: {},
		scope: initialScope,
	};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === undefined || argument === "--trust-project") {
			continue;
		}
		const nextIndex =
			parseScopeOption(args, index, argument, result) ??
			parseTransportOption(args, index, argument, result) ??
			parseCollectionOption(args, index, argument, result) ??
			parseAuthOption(args, index, argument, result);
		if (nextIndex === undefined) {
			throw new Error(`Unknown MCP add option '${argument}'.`);
		}
		index = nextIndex;
	}
	return result;
};

const optionsForConfig = async (
	cwd: string,
	trustProject: boolean,
	options: McpCliOptions
): Promise<McpCliRuntime> => {
	const homeRoot = options.homeRoot ?? os.homedir();
	const workspace = resolveWorkspaceRoot(cwd);
	const trust = await resolveProjectTrust({
		mode: "print",
		...(trustProject ? { override: "trust" } : {}),
		projectTrustDir: options.projectTrustDir ?? resolveUserWincodeDir(homeRoot),
		workspace,
	});
	const trustedProjectRoots =
		options.trustedProjectRoots ??
		(trustProject
			? [...new Set([...trust.trustedProjectRoots, workspace])]
			: trust.trustedProjectRoots);
	return {
		configStore:
			options.configStore ??
			createConfigStore({ homeRoot, trustedProjectRoots }),
		trustedProjectRoots,
		workspace,
	};
};

const runList = async (
	args: readonly string[],
	management: McpManagementApi,
	io: McpCliIo
): Promise<void> => {
	const result = await management.list();
	const json = args.includes("--json");
	if (json) {
		io.stdout.write(`${JSON.stringify(result.servers, null, 2)}\n`);
	} else if (Object.keys(result.servers).length === 0) {
		outputLine(io.stdout, "No MCP servers configured.");
	} else {
		for (const [name, server] of Object.entries(result.servers)) {
			const source = result.serverSources?.[name];
			const auth =
				server.type === "remote" && server.auth === "oauth"
					? "OAuth"
					: "no auth";
			outputLine(
				io.stdout,
				`${name}\t${server.type}\t${server.disabled ? "disabled" : "enabled"}\t${server.exposure ?? "direct"}\t${auth}\t${source?.scope ?? "unknown"}`
			);
		}
	}
	for (const diagnostic of result.diagnostics) {
		outputLine(io.stderr, `MCP: ${diagnostic.message} (${diagnostic.path})`);
	}
};

const runLogin = async (
	name: string,
	management: McpManagementApi,
	userDataDir: string,
	stdinIsTTY: boolean,
	io: McpCliIo,
	options: McpCliOptions
): Promise<void> => {
	const secrets = createPluginSecretStore("mcp", userDataDir);
	await management.login({
		name,
		openAuthorizationUrl:
			options.openAuthorizationUrl ??
			(async (url) => {
				outputLine(io.stdout, `Opening OAuth authorization: ${url.toString()}`);
				await open(url.toString());
			}),
		readRedirectUrl:
			options.readRedirectUrl ??
			(async (callback) => {
				if (!stdinIsTTY) {
					return await callback;
				}
				const terminal = createInterface({
					input: process.stdin,
					output: process.stderr,
				});
				try {
					const pasted = terminal
						.question(
							"Paste the OAuth redirect URL here, or complete authorization in your browser: "
						)
						.then((value) => new URL(value.trim()));
					return await Promise.race([callback, pasted]);
				} finally {
					terminal.close();
				}
			}),
		secrets,
	});
	outputLine(io.stdout, `MCP Server '${name}' is signed in.`);
};

const runLogout = async (
	name: string,
	management: McpManagementApi,
	userDataDir: string,
	io: McpCliIo
): Promise<void> => {
	await management.logout({
		name,
		secrets: createPluginSecretStore("mcp", userDataDir),
	});
	outputLine(io.stdout, `MCP Server '${name}' is signed out.`);
};

const isWorkspaceTrusted = (runtime: McpCliRuntime): boolean =>
	runtime.trustedProjectRoots.some(
		(root) => path.resolve(root) === path.resolve(runtime.workspace)
	);

const requireTrustedProjectWrite = (
	runtime: McpCliRuntime,
	message: string
): void => {
	if (!isWorkspaceTrusted(runtime)) {
		throw new Error(message);
	}
};

const managementForRuntime = (
	runtime: McpCliRuntime,
	options: McpCliOptions
): McpManagementApi =>
	createMcpManagement({
		authorizeWrite: (scope) => {
			if (scope === "project") {
				requireTrustedProjectWrite(
					runtime,
					"Project MCP configuration requires a trusted project; use --trust-project explicitly."
				);
			}
		},
		config: {
			getSnapshot: () =>
				runtime.configStore.getNamespaceSnapshot(runtime.workspace, "mcp"),
			setValue: async (scope, configPath, value) => {
				await runtime.configStore.setNamespaceValue(
					runtime.workspace,
					scope,
					"mcp",
					configPath,
					value
				);
			},
		},
		env: { ...process.env },
		oauth: options.oauthOperations,
		workspace: runtime.workspace,
	});

const runAdd = async (
	args: readonly string[],
	initialScope: Scope,
	management: McpManagementApi,
	io: McpCliIo
): Promise<void> => {
	const serverArgs = args.filter(
		(argument) =>
			argument !== "--trust-project" && !argument.startsWith("--scope")
	);
	const name = serverArgs[0];
	if (name === undefined) {
		throw new Error("MCP add requires a server name.");
	}
	const parsed = parseAddOptions(
		args.slice(args.indexOf(name) + 1),
		initialScope
	);
	await management.add({ ...parsed, name });
	outputLine(
		io.stdout,
		`Added MCP Server '${name}' to ${parsed.scope} config.`
	);
};

const runRemove = async (
	args: readonly string[],
	requestedScope: Scope,
	explicitScope: boolean,
	management: McpManagementApi,
	io: McpCliIo
): Promise<void> => {
	const name = args.find((argument) => !argument.startsWith("--"));
	if (name === undefined) {
		throw new Error("MCP remove requires a server name.");
	}
	const scope = await management.remove({
		name,
		...(explicitScope ? { scope: requestedScope } : {}),
	});
	outputLine(io.stdout, `Removed MCP Server '${name}' from ${scope} config.`);
};

const runAuthentication = async (
	action: "login" | "logout",
	args: readonly string[],
	management: McpManagementApi,
	io: McpCliIo,
	options: McpCliOptions
): Promise<void> => {
	const name = args.find((argument) => !argument.startsWith("--"));
	if (name === undefined) {
		throw new Error(`MCP ${action} requires a server name.`);
	}
	const userDataDir = options.userDataDir ?? resolveUserDataDir();
	if (action === "login") {
		await runLogin(name, management, userDataDir, io.stdinIsTTY, io, options);
		return;
	}
	await runLogout(name, management, userDataDir, io);
};

const runMcpAction = async (
	action: string,
	args: readonly string[],
	trustOptions: Readonly<{
		explicitScope: boolean;
		scope: Scope;
		trustProject: boolean;
	}>,
	management: McpManagementApi,
	io: McpCliIo,
	options: McpCliOptions
): Promise<void> => {
	if (action === "list") {
		await runList(args, management, io);
		return;
	}
	if (action === "add") {
		await runAdd(args, trustOptions.scope, management, io);
		return;
	}
	if (action === "remove") {
		await runRemove(
			args,
			trustOptions.scope,
			trustOptions.explicitScope,
			management,
			io
		);
		return;
	}
	if (action === "login" || action === "logout") {
		await runAuthentication(action, args, management, io, options);
		return;
	}
	throw new Error(`Unknown MCP command '${action}'. Use 'wincode mcp --help'.`);
};

/** Runs the non-TUI MCP server-management CLI. */
export const runMcpCli = async (
	args: readonly string[],
	cwd: string,
	io: McpCliIo,
	options: McpCliOptions = {}
): Promise<number> => {
	try {
		const [action, ...rest] = args;
		if (action === undefined || action === "--help" || action === "-h") {
			outputLine(io.stdout, HELP_TEXT);
			return 0;
		}
		const trustOptions = parseScopeAndTrust(rest);
		const runtime = await optionsForConfig(
			cwd,
			trustOptions.trustProject,
			options
		);
		await runMcpAction(
			action,
			rest,
			trustOptions,
			managementForRuntime(runtime, options),
			io,
			options
		);
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		outputLine(io.stderr, `error: ${message}`);
		return 1;
	}
};
