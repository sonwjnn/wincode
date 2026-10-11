import {
	type McpConfigResult,
	type McpConfigSnapshot,
	resolveMcpConfig,
} from "./config";
import {
	mcpServerNameSchema,
	type RawMcpServerConfig,
	rawServerSchema,
} from "./config/schema";
import {
	loginMcpServer,
	logoutMcpServer,
	type McpOAuthLoginInput,
	type McpSecretStore,
} from "./oauth";

export type McpManagementScope = "global" | "project";

export type McpManagementConfigAccess = Readonly<{
	getSnapshot: () => Promise<McpConfigSnapshot>;
	setValue: (
		scope: McpManagementScope,
		path: readonly string[],
		value: unknown
	) => Promise<void>;
}>;

export type McpManagementAddInput = Readonly<{
	args?: readonly string[];
	auth?: "oauth";
	command?: string;
	cwd?: string;
	env?: Readonly<Record<string, string>>;
	headers?: Readonly<Record<string, string>>;
	name: string;
	scope: McpManagementScope;
	url?: string;
}>;

export type McpManagementLoginInput = Readonly<{
	name: string;
	openAuthorizationUrl: McpOAuthLoginInput["openAuthorizationUrl"];
	readRedirectUrl?: McpOAuthLoginInput["readRedirectUrl"];
	secrets: McpSecretStore;
}>;

export type McpManagementLogoutInput = Readonly<{
	name: string;
	secrets: McpSecretStore;
}>;

export type McpManagementOAuthOperations = Readonly<{
	login: (input: McpOAuthLoginInput) => Promise<void>;
	logout: (secrets: McpSecretStore, serverName: string) => Promise<void>;
}>;

export type McpManagementApi = Readonly<{
	add: (input: McpManagementAddInput) => Promise<void>;
	list: () => Promise<McpConfigResult>;
	login: (input: McpManagementLoginInput) => Promise<void>;
	logout: (input: McpManagementLogoutInput) => Promise<void>;
	remove: (
		input: Readonly<{ name: string; scope?: McpManagementScope }>
	) => Promise<McpManagementScope>;
}>;

export type McpManagementDependencies = Readonly<{
	authorizeWrite: (scope: McpManagementScope) => void;
	config: McpManagementConfigAccess;
	env: Readonly<Record<string, string | undefined>>;
	oauth?: McpManagementOAuthOperations;
	workspace: string;
}>;

const validateScope = (scope: string): void => {
	if (scope !== "global" && scope !== "project") {
		throw new Error("MCP config scope must be user or project.");
	}
};

const validateName = (name: string): void => {
	if (!mcpServerNameSchema.safeParse(name).success) {
		throw new Error(
			"Server names may contain only letters, digits, underscores, and hyphens."
		);
	}
};

const hasServerInScope = (
	snapshot: McpConfigSnapshot,
	scope: McpManagementScope,
	name: string
): boolean =>
	snapshot.sources.some((source) => {
		if (source.scope !== scope) {
			return false;
		}
		const servers = source.document.mcpServers;
		return (
			typeof servers === "object" &&
			servers !== null &&
			!Array.isArray(servers) &&
			Object.hasOwn(servers, name)
		);
	});

const assertValidAddOptions = (input: McpManagementAddInput): void => {
	const hasCommand = input.command !== undefined;
	const hasUrl = input.url !== undefined;
	if (hasCommand === hasUrl) {
		throw new Error("Provide exactly one of --command or --url.");
	}
	if (hasCommand && Object.keys(input.headers ?? {}).length > 0) {
		throw new Error("--header can be used only with --url.");
	}
	if (
		hasUrl &&
		((input.args?.length ?? 0) > 0 ||
			input.cwd !== undefined ||
			Object.keys(input.env ?? {}).length > 0)
	) {
		throw new Error("--arg, --cwd, and --env can be used only with --command.");
	}
	if (hasCommand && input.auth !== undefined) {
		throw new Error("OAuth authentication can be used only with --url.");
	}
};

const rawServerConfigFor = (
	input: McpManagementAddInput
): RawMcpServerConfig =>
	input.command === undefined
		? {
				url: input.url,
				...(input.headers === undefined ||
				Object.keys(input.headers).length === 0
					? {}
					: { headers: { ...input.headers } }),
				...(input.auth === undefined ? {} : { auth: input.auth }),
			}
		: {
				command: input.command,
				...(input.args === undefined || input.args.length === 0
					? {}
					: { args: [...input.args] }),
				...(input.cwd === undefined ? {} : { cwd: input.cwd }),
				...(input.env === undefined || Object.keys(input.env).length === 0
					? {}
					: { env: { ...input.env } }),
			};

const rawServerFor = (input: McpManagementAddInput): RawMcpServerConfig => {
	assertValidAddOptions(input);
	const parsed = rawServerSchema.safeParse(rawServerConfigFor(input));
	if (!parsed.success) {
		throw new Error(
			`Invalid MCP server configuration: ${parsed.error.issues
				.map(({ message }) => message)
				.join("; ")}`
		);
	}
	return parsed.data;
};

export const createMcpManagement = ({
	authorizeWrite,
	config,
	env,
	oauth = { login: loginMcpServer, logout: logoutMcpServer },
	workspace,
}: McpManagementDependencies): McpManagementApi => {
	const resolveConfig = async (): Promise<{
		result: McpConfigResult;
		snapshot: McpConfigSnapshot;
	}> => {
		const snapshot = await config.getSnapshot();
		return {
			result: await resolveMcpConfig({ env, snapshot, workspace }),
			snapshot,
		};
	};

	const oauthServer = async (name: string) => {
		validateName(name);
		const { result } = await resolveConfig();
		const server = result.servers[name];
		if (
			server === undefined ||
			server.type !== "remote" ||
			server.auth !== "oauth"
		) {
			throw new Error(`MCP Server '${name}' is not a configured OAuth server.`);
		}
		return server;
	};

	return {
		add: async (input) => {
			validateScope(input.scope);
			validateName(input.name);
			const rawServer = rawServerFor(input);
			authorizeWrite(input.scope);
			const snapshot = await config.getSnapshot();
			if (hasServerInScope(snapshot, input.scope, input.name)) {
				const label = input.scope === "global" ? "user" : "project";
				throw new Error(
					`MCP Server '${input.name}' already exists in ${label} config.`
				);
			}
			await config.setValue(input.scope, ["mcpServers", input.name], rawServer);
		},
		list: async () => (await resolveConfig()).result,
		login: async (input) => {
			const server = await oauthServer(input.name);
			await oauth.login({
				openAuthorizationUrl: input.openAuthorizationUrl,
				oauth: server.oauth,
				readRedirectUrl: input.readRedirectUrl,
				secrets: input.secrets,
				serverName: input.name,
				serverUrl: server.url,
			});
		},
		logout: async (input) => {
			await oauthServer(input.name);
			await oauth.logout(input.secrets, input.name);
		},
		remove: async ({ name, scope: requestedScope }) => {
			validateName(name);
			if (requestedScope !== undefined) {
				validateScope(requestedScope);
				authorizeWrite(requestedScope);
			}
			const { result, snapshot } = await resolveConfig();
			if (result.servers[name] === undefined) {
				throw new Error(`MCP Server '${name}' does not exist.`);
			}
			const scope =
				requestedScope ??
				(result.serverSources?.[name]?.scope === "project"
					? "project"
					: "global");
			if (!hasServerInScope(snapshot, scope, name)) {
				const label = scope === "global" ? "user" : "project";
				throw new Error(
					`MCP Server '${name}' does not exist in ${label} config.`
				);
			}
			if (requestedScope === undefined) {
				authorizeWrite(scope);
			}
			await config.setValue(scope, ["mcpServers", name], undefined);
			return scope;
		},
	};
};
