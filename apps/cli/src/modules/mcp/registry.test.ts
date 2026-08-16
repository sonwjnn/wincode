import { describe, expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/client";
import {
	createToolPermission,
	type PermissionRules,
} from "@/modules/permissions";
import { resolveToolPermissionPolicies } from "@/modules/permissions/use-tool-permission";
import type { McpClient, McpClientTool } from "./client";
import type {
	LocalMcpServerConfig,
	McpConfigResult,
	McpTimeouts,
	RemoteMcpServerConfig,
	ResolvedMcpServerConfig,
} from "./config";
import type { McpExecutionPolicy } from "./policy";
import {
	createMcpRegistry,
	type McpAgentPolicy,
	type McpRegistry,
	type McpRegistryDeps,
	mcpDeniedByPolicyText,
} from "./registry";

class FakeMcpClient implements McpClient {
	readonly name: string;
	closeCount = 0;
	connectCount = 0;
	connectFailure: Error | null = null;
	listFailure: Error | null = null;
	tools: readonly McpClientTool[];
	callImpl: (
		name: string,
		input: unknown,
		signal?: AbortSignal
	) => Promise<CallToolResult> = async () => ({ content: [] });
	private listener: ((tools: readonly McpClientTool[]) => void) | undefined;

	constructor(name: string, tools: readonly McpClientTool[] = []) {
		this.name = name;
		this.tools = tools;
	}

	connectImpl: ((signal?: AbortSignal) => Promise<void>) | undefined;

	async connect(signal?: AbortSignal): Promise<void> {
		this.connectCount += 1;
		if (this.connectImpl !== undefined) {
			return this.connectImpl(signal);
		}
		if (signal?.aborted) {
			throw new DOMException("Aborted", "AbortError");
		}
		if (this.connectFailure !== null) {
			throw this.connectFailure;
		}
	}

	async close(): Promise<void> {
		this.closeCount += 1;
	}

	async listTools(signal?: AbortSignal): Promise<readonly McpClientTool[]> {
		if (signal?.aborted) {
			throw new DOMException("Aborted", "AbortError");
		}
		if (this.listFailure !== null) {
			throw this.listFailure;
		}
		return this.tools;
	}

	async callTool(
		name: string,
		input: unknown,
		signal?: AbortSignal
	): Promise<CallToolResult> {
		return this.callImpl(name, input, signal);
	}

	setToolsChangedListener(
		listener: (tools: readonly McpClientTool[]) => void
	): void {
		this.listener = listener;
	}

	publishTools(tools: readonly McpClientTool[]): void {
		this.tools = tools;
		this.listener?.([...tools]);
	}
}

// Agent policies target MCP tools by open-glob keys (`*`, `demo_*`) that sit
// outside the nominal PermissionAction union; the registry evaluates them as
// globs, so tests cast the literals just as the policy module does.
const openRules = (rules: Record<string, "allow" | "ask" | "deny">) =>
	rules as PermissionRules;

const hangingCall =
	(): NonNullable<FakeMcpClient["callImpl"]> => (_name, _input, signal) =>
		new Promise<CallToolResult>((_resolve, reject) => {
			if (signal?.aborted) {
				reject(new DOMException("Aborted", "AbortError"));
				return;
			}
			signal?.addEventListener("abort", () =>
				reject(new DOMException("Aborted", "AbortError"))
			);
		});

const tool = (name: string, description?: string): McpClientTool => ({
	name,
	inputSchema: { type: "object" },
	...(description === undefined ? {} : { description }),
});

const DEFAULT_TIMEOUTS = {
	startup: 30_000,
	catalog: 30_000,
	execution: 43_200_000,
} as const;

type ServerConfigPatch = {
	disabled?: boolean;
	permission?: McpExecutionPolicy;
	timeout?: McpTimeouts;
	type?: "local" | "remote";
} & Partial<Pick<LocalMcpServerConfig, "command" | "cwd" | "environment">> &
	Partial<Pick<RemoteMcpServerConfig, "headers" | "url">>;

const serverConfig = (
	name: string,
	patch: ServerConfigPatch = {}
): ResolvedMcpServerConfig => {
	if (patch.type === "remote") {
		return {
			name,
			type: "remote",
			url: patch.url ?? "https://mcp.example.com/mcp",
			disabled: patch.disabled ?? false,
			permission: patch.permission ?? "ask",
			timeout: patch.timeout ?? DEFAULT_TIMEOUTS,
			...(patch.headers === undefined ? {} : { headers: patch.headers }),
		};
	}
	return {
		name,
		type: "local",
		command: patch.command ?? ["bun", "x", name],
		disabled: patch.disabled ?? false,
		permission: patch.permission ?? "ask",
		timeout: patch.timeout ?? DEFAULT_TIMEOUTS,
	};
};

type HarnessOptions = {
	clients?: Record<string, FakeMcpClient>;
	configs?: ResolvedMcpServerConfig[];
	deps?: Partial<McpRegistryDeps>;
};

type Harness = {
	clients: Map<string, FakeMcpClient>;
	registry: McpRegistry;
};

const harness = (options: HarnessOptions = {}): Harness => {
	const clients = new Map<string, FakeMcpClient>();
	for (const [name, client] of Object.entries(options.clients ?? {})) {
		clients.set(name, client);
	}
	const configs = options.configs ?? [];
	const registry = createMcpRegistry({
		env: {},
		workspace: "/workspace",
		createClient: (config) => {
			const existing = clients.get(config.name);
			if (existing !== undefined) {
				return existing;
			}
			const created = new FakeMcpClient(config.name);
			clients.set(config.name, created);
			return created;
		},
		loadConfig: async (): Promise<McpConfigResult> => ({
			diagnostics: [],
			servers: Object.fromEntries(
				configs.map((config) => [config.name, config])
			),
		}),
		...options.deps,
	});
	return { clients, registry };
};

describe("createMcpRegistry", () => {
	test("a rejected Agent Registry resolution leaves Plan with no visible MCP tools", async () => {
		let fallbackPermission = createToolPermission({ edit: "deny" });
		const resolution = resolveToolPermissionPolicies(
			Promise.reject(new Error("Agent Registry unavailable")),
			"plan",
			() => fallbackPermission
		);
		fallbackPermission = createToolPermission();
		const resolved = await resolution;
		const demo = new FakeMcpClient("demo", [tool("echo")]);
		const { registry } = harness({
			clients: { demo },
			configs: [serverConfig("demo", { permission: "allow" })],
		});

		const snapshot = await registry.createSnapshot("plan", resolved.mcpPolicy);

		expect(resolved.permission).toBe(fallbackPermission);
		expect(snapshot.manifest).toEqual([]);
		expect(snapshot.tools.size).toBe(1);
		for (const entry of snapshot.tools.values()) {
			expect(entry.policy).toBe("deny");
		}
	});

	test("plan snapshot connects and builds a catalog under the default policy", async () => {
		// Plan no longer short-circuits: visibility is purely policy-driven, so a
		// plan snapshot with the permissive default policy connects and exposes
		// tools exactly like build. The empty-Plan baseline comes from the shipped
		// Plan policy denying every open-glob action (see the next test).
		const demo = new FakeMcpClient("demo", [tool("echo")]);
		const { registry } = harness({
			clients: { demo },
			configs: [serverConfig("demo", { permission: "allow" })],
		});
		const snapshot = await registry.createSnapshot("plan");
		expect(snapshot.agent).toBe("plan");
		expect(snapshot.manifest).toHaveLength(1);
		expect(snapshot.tools.size).toBe(1);
		expect(demo.connectCount).toBe(1);
	});

	test("an all-deny agent policy empties the manifest but keeps dispatch entries", async () => {
		const demo = new FakeMcpClient("demo", [tool("echo")]);
		const { registry } = harness({
			clients: { demo },
			configs: [serverConfig("demo", { permission: "allow" })],
		});
		const snapshot = await registry.createSnapshot("plan", {
			rules: openRules({ "*": "deny" }),
			safety: false,
		});
		// A denied tool is absent from the manifest the model sees, yet retained in
		// the dispatch map marked deny so a stray call resolves to a policy denial
		// rather than an unknown-tool error.
		expect(snapshot.manifest).toEqual([]);
		expect(snapshot.tools.size).toBe(1);
		for (const entry of snapshot.tools.values()) {
			expect(entry.policy).toBe("deny");
			expect(entry.logicalName).toBe("demo_echo");
		}
	});

	test("connects enabled servers concurrently and isolates failures", async () => {
		const healthy = new FakeMcpClient("healthy", [tool("echo")]);
		const broken = new FakeMcpClient("broken", [tool("read")]);
		broken.connectFailure = new Error("connection refused");
		const { registry } = harness({
			clients: { healthy, broken },
			configs: [serverConfig("healthy"), serverConfig("broken")],
		});
		const snapshot = await registry.createSnapshot("build");
		expect(snapshot.manifest).toHaveLength(1);
		expect(registry.getStatuses()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "healthy",
					state: "connected",
					toolCount: 1,
				}),
				expect.objectContaining({
					name: "broken",
					state: "failed",
					toolCount: 0,
				}),
			])
		);
		expect(healthy.connectCount).toBe(1);
		expect(broken.connectCount).toBe(1);
	});

	test("fails when a remote tools filter requests a missing tool", async () => {
		const websearch = new FakeMcpClient("websearch", [tool("web_search_exa")]);
		const { registry } = harness({
			clients: { websearch },
			configs: [
				serverConfig("websearch", {
					type: "remote",
					url: "https://mcp.example.com/mcp?tools=web_search_ex",
				}),
			],
		});

		await registry.initialize();

		expect(registry.getStatuses()).toContainEqual(
			expect.objectContaining({
				error: "MCP server did not expose all requested tools",
				name: "websearch",
				state: "failed",
			})
		);
	});

	test("connects when a remote tools filter matches the exposed catalog", async () => {
		const websearch = new FakeMcpClient("websearch", [tool("web_search_exa")]);
		const { registry } = harness({
			clients: { websearch },
			configs: [
				serverConfig("websearch", {
					type: "remote",
					url: "https://mcp.example.com/mcp?tools=web_search_exa",
				}),
			],
		});

		await registry.initialize();

		expect(registry.getStatuses()).toContainEqual(
			expect.objectContaining({
				name: "websearch",
				state: "connected",
				toolCount: 1,
			})
		);
	});

	test("reports disabled servers without connecting", async () => {
		const { clients, registry } = harness({
			configs: [
				serverConfig("off", { disabled: true }),
				serverConfig("on", { disabled: false }),
			],
		});
		await registry.createSnapshot("build");
		expect(registry.getStatuses()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "off", state: "disabled" }),
				expect.objectContaining({ name: "on", state: "connected" }),
			])
		);
		expect(clients.size).toBe(1);
	});

	test("omits denied tools from the manifest but still blocks execution", async () => {
		const github = new FakeMcpClient("github", [tool("read"), tool("write")]);
		const { registry } = harness({
			clients: { github },
			configs: [serverConfig("github", { permission: "deny" })],
		});
		const snapshot = await registry.createSnapshot("build");
		expect(snapshot.manifest).toEqual([]);
		expect(snapshot.tools.size).toBe(2);
		const readName = [...snapshot.tools.keys()].find(
			(name) => snapshot.tools.get(name)?.originalToolName === "read"
		);
		const result = await registry.execute(snapshot, readName ?? "", {});
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("denied");
	});

	test("bypasses approval when the policy allows", async () => {
		const demo = new FakeMcpClient("demo", [tool("echo")]);
		const { registry } = harness({
			clients: { demo },
			configs: [serverConfig("demo", { permission: "allow" })],
		});
		const snapshot = await registry.createSnapshot("build");
		const name = snapshot.manifest[0]?.name ?? "";
		const result = await registry.execute(snapshot, name, {});
		expect(result.isError).toBe(false);
	});

	test("times out execution, sanitizes the error, closes, and degrades the server", async () => {
		const demo = new FakeMcpClient("demo", [tool("echo")]);
		demo.callImpl = hangingCall();
		const { registry } = harness({
			clients: { demo },
			configs: [
				serverConfig("demo", {
					timeout: {
						startup: 30_000,
						catalog: 30_000,
						execution: 25,
					},
				}),
			],
		});
		const snapshot = await registry.createSnapshot("build");
		const name = snapshot.manifest[0]?.name ?? "";
		const result = await registry.execute(snapshot, name, {});
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("timed out");
		expect(JSON.stringify(result.content)).not.toContain("AbortError");
		expect(demo.closeCount).toBeGreaterThan(0);
		expect(registry.getStatuses()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "demo", state: "degraded" }),
			])
		);
	});

	test("sanitizes execution errors so secrets never leak", async () => {
		const demo = new FakeMcpClient("demo", [tool("echo")]);
		demo.callImpl = async () => {
			throw new Error("call failed with Bearer super-secret-token");
		};
		const { registry } = harness({
			clients: { demo },
			configs: [
				serverConfig("demo", {
					type: "remote",
					url: "https://secret.example.com/mcp",
					headers: { Authorization: "Bearer super-secret-token" },
				}),
			],
		});
		const snapshot = await registry.createSnapshot("build");
		const name = snapshot.manifest[0]?.name ?? "";
		const result = await registry.execute(snapshot, name, {});
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).not.toContain("super-secret-token");
		expect(JSON.stringify(result.content)).not.toContain("secret.example.com");
	});

	test("returns an output error for unknown tools", async () => {
		const demo = new FakeMcpClient("demo", [tool("echo")]);
		const { registry } = harness({
			clients: { demo },
			configs: [serverConfig("demo")],
		});
		const snapshot = await registry.createSnapshot("build");
		const result = await registry.execute(
			snapshot,
			"mcp_unknown_tool_00000000",
			{}
		);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("Unknown");
	});

	test("returns a registry-owned policy denial for a denied dispatch entry", async () => {
		const demo = new FakeMcpClient("demo", [tool("echo")]);
		const { registry } = harness({
			clients: { demo },
			configs: [serverConfig("demo", { permission: "allow" })],
		});
		const snapshot = await registry.createSnapshot("plan", {
			rules: openRules({ "*": "deny" }),
			safety: false,
		});
		const name = [...snapshot.tools.keys()][0] ?? "";
		const result = await registry.execute(snapshot, name, {});
		expect(result).toMatchObject({
			content: [{ text: mcpDeniedByPolicyText(name), type: "text" }],
			isError: true,
			owner: "registry",
		});
	});

	test("rejects snapshots that are no longer current", async () => {
		const demo = new FakeMcpClient("demo", [tool("echo")]);
		const { registry } = harness({
			clients: { demo },
			configs: [serverConfig("demo")],
		});
		const first = await registry.createSnapshot("build");
		await registry.createSnapshot("build");
		const name = first.manifest[0]?.name ?? "";
		const result = await registry.execute(first, name, {});
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("stale");
	});

	test("reflects list changes in the next snapshot and keeps the old one executable", async () => {
		const demo = new FakeMcpClient("demo", [tool("one")]);
		const { registry } = harness({
			clients: { demo },
			configs: [serverConfig("demo")],
		});
		const first = await registry.createSnapshot("build");
		const firstName = first.manifest[0]?.name ?? "";
		demo.publishTools([tool("two")]);
		const result = await registry.execute(first, firstName, {});
		expect(result.isError).toBe(false);
		const second = await registry.createSnapshot("build");
		expect(second.manifest).toHaveLength(1);
		expect(
			second.tools.get(second.manifest[0]?.name ?? "")?.originalToolName
		).toBe("two");
		expect(first.tools.get(firstName)?.originalToolName).toBe("one");
	});

	test("keeps an in-flight snapshot immutable while tools change", async () => {
		const demo = new FakeMcpClient("demo", [tool("one")]);
		let release: (() => void) | undefined;
		demo.callImpl = () =>
			new Promise<CallToolResult>((resolve) => {
				release = () => resolve({ content: [] });
			});
		const { registry } = harness({
			clients: { demo },
			configs: [serverConfig("demo")],
		});
		const snapshot = await registry.createSnapshot("build");
		const name = snapshot.manifest[0]?.name ?? "";
		const pending = registry.execute(snapshot, name, {});
		demo.publishTools([tool("two")]);
		await registry.createSnapshot("build");
		expect(snapshot.tools.get(name)?.originalToolName).toBe("one");
		expect(snapshot.tools.size).toBe(1);
		release?.();
		const result = await pending;
		expect(result.isError).toBe(false);
	});

	test("reconnects a failed server with a fresh client and recovers its tools", async () => {
		const created: FakeMcpClient[] = [];
		let first = true;
		const { registry } = harness({
			configs: [serverConfig("broken")],
			deps: {
				createClient: (config) => {
					const client = new FakeMcpClient(config.name, [tool("echo")]);
					if (first) {
						client.connectFailure = new Error("down");
						first = false;
					}
					created.push(client);
					return client;
				},
			},
		});
		await registry.createSnapshot("build");
		expect(registry.getStatuses()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "broken", state: "failed" }),
			])
		);
		expect(created).toHaveLength(1);
		expect(created[0]?.connectCount).toBe(1);
		await registry.reconnect("broken");
		expect(created).toHaveLength(2);
		expect(created[1]).not.toBe(created[0]);
		expect(created[1]?.connectCount).toBe(1);
		expect(created[0]?.closeCount).toBeGreaterThan(0);
		expect(registry.getStatuses()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "broken",
					state: "connected",
					toolCount: 1,
				}),
			])
		);
		created[0]?.publishTools([tool("stale-one"), tool("stale-two")]);
		expect(registry.getStatuses()).toContainEqual(
			expect.objectContaining({
				name: "broken",
				state: "connected",
				toolCount: 1,
			})
		);
		const snapshot = await registry.createSnapshot("build");
		expect(snapshot.manifest).toHaveLength(1);
	});

	test("clears stale tools when reconnect fails", async () => {
		let createCount = 0;
		const { registry } = harness({
			configs: [serverConfig("demo")],
			deps: {
				createClient: (config) => {
					createCount += 1;
					const client = new FakeMcpClient(config.name, [tool("echo")]);
					if (createCount > 1) {
						client.connectFailure = new Error("down");
					}
					return client;
				},
			},
		});
		await registry.initialize();

		await registry.reconnect("demo");

		expect(registry.getStatuses()).toContainEqual(
			expect.objectContaining({
				name: "demo",
				state: "failed",
				toolCount: 0,
			})
		);
	});

	test("dedupes concurrent reconnects for the same server", async () => {
		const releases: (() => void)[] = [];
		const created: FakeMcpClient[] = [];
		const gatedConnect = (signal: AbortSignal | undefined): Promise<void> =>
			new Promise<void>((resolve, reject) => {
				if (signal?.aborted) {
					reject(new DOMException("Aborted", "AbortError"));
					return;
				}
				signal?.addEventListener("abort", () =>
					reject(new DOMException("Aborted", "AbortError"))
				);
				releases.push(() => resolve());
			});
		const { registry } = harness({
			configs: [serverConfig("demo")],
			deps: {
				createClient: (config) => {
					const client = new FakeMcpClient(config.name, [tool("echo")]);
					created.push(client);
					if (created.length > 1) {
						client.connectImpl = gatedConnect;
					}
					return client;
				},
			},
		});
		await registry.createSnapshot("build");
		expect(created).toHaveLength(1);
		const first = registry.reconnect("demo");
		const second = registry.reconnect("demo");
		expect(second).toBe(first);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(created).toHaveLength(2);
		expect(created[1]?.connectCount).toBe(1);
		for (const release of releases) {
			release();
		}
		await first;
		expect(registry.getStatuses()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "demo", state: "connected" }),
			])
		);
		expect(created).toHaveLength(2);
	});

	test("toggle waits for an in-flight reconnect and leaves the server disabled", async () => {
		const demo = new FakeMcpClient("demo", [tool("echo")]);
		const { registry } = harness({
			clients: { demo },
			configs: [serverConfig("demo")],
		});
		await registry.initialize();
		let releaseReconnect: (() => void) | undefined;
		demo.connectImpl = () =>
			new Promise<void>((resolve) => {
				releaseReconnect = resolve;
			});

		const reconnecting = registry.reconnect("demo");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const toggling = registry.toggle("demo");
		releaseReconnect?.();
		await Promise.all([reconnecting, toggling]);

		expect(registry.getStatuses()).toContainEqual(
			expect.objectContaining({
				name: "demo",
				state: "disabled",
				toolCount: 0,
			})
		);
	});

	test("reconnect on a disabled server is a no-op", async () => {
		const { clients, registry } = harness({
			configs: [serverConfig("off", { disabled: true })],
		});
		await registry.createSnapshot("build");
		await registry.reconnect("off");
		expect(registry.getStatuses()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "off", state: "disabled" }),
			])
		);
		expect(clients.size).toBe(0);
	});

	test("toggle disables a connected server and clears its tools", async () => {
		const demo = new FakeMcpClient("demo", [tool("echo")]);
		const { registry } = harness({
			clients: { demo },
			configs: [serverConfig("demo")],
		});
		const snapshot = await registry.createSnapshot("build");

		await registry.toggle("demo");

		expect(demo.closeCount).toBe(1);
		expect(registry.getStatuses()).toContainEqual(
			expect.objectContaining({
				name: "demo",
				state: "disabled",
				toolCount: 0,
			})
		);
		const staleResult = await registry.execute(
			snapshot,
			snapshot.manifest[0]?.name ?? "",
			{}
		);
		expect(staleResult).toMatchObject({
			isError: true,
			content: [
				{ type: "text", text: "MCP tool snapshot is stale or not executable" },
			],
		});
	});

	test("toggle enables a disabled server and discovers its tools", async () => {
		const off = new FakeMcpClient("off", [tool("echo")]);
		const { registry } = harness({
			clients: { off },
			configs: [serverConfig("off", { disabled: true })],
		});
		await registry.initialize();

		await registry.toggle("off");

		expect(off.connectCount).toBe(1);
		expect(registry.getStatuses()).toContainEqual(
			expect.objectContaining({
				name: "off",
				state: "connected",
				toolCount: 1,
			})
		);
	});

	test("toggle marks a server failed when its config becomes invalid", async () => {
		let servers: McpConfigResult["servers"] = {
			websearch: serverConfig("websearch", { type: "remote" }),
		};
		let diagnostics: McpConfigResult["diagnostics"] = [];
		const { registry } = harness({
			deps: {
				loadConfig: async (): Promise<McpConfigResult> => ({
					diagnostics,
					servers,
				}),
			},
		});
		await registry.initialize();
		servers = {};
		diagnostics = [
			{
				code: "invalid-url",
				message: "URL must be absolute http or https URL",
				path: "/workspace/wincode.json:mcp.websearch.url",
				scope: "project",
				serverName: "websearch",
			},
		];

		await registry.toggle("websearch");
		await registry.toggle("websearch");

		expect(registry.getStatuses()).toContainEqual(
			expect.objectContaining({
				error: "Invalid MCP server configuration",
				name: "websearch",
				state: "failed",
			})
		);
	});

	test("reconnect reloads repaired server config", async () => {
		let config = serverConfig("websearch", { type: "remote" });
		const configsUsed: ResolvedMcpServerConfig[] = [];
		const { registry } = harness({
			deps: {
				createClient: (server) => {
					configsUsed.push(server);
					return new FakeMcpClient(server.name);
				},
				loadConfig: async (): Promise<McpConfigResult> => ({
					diagnostics: [],
					servers: { websearch: config },
				}),
			},
		});
		await registry.initialize();
		config = serverConfig("websearch", {
			type: "remote",
			url: "https://repaired.example.com/mcp",
		});

		await registry.reconnect("websearch");

		expect(configsUsed.at(-1)).toMatchObject({
			url: "https://repaired.example.com/mcp",
		});
		expect(registry.getStatuses()).toContainEqual(
			expect.objectContaining({ name: "websearch", state: "connected" })
		);
	});

	test("keeps an invalid startup config visible and reconnects after repair", async () => {
		const refreshes: Array<boolean | undefined> = [];
		let configResult: McpConfigResult = {
			diagnostics: [],
			invalidServers: {
				websearch: {
					error: "URL must be absolute http or https URL",
					name: "websearch",
					transport: "remote",
				},
			},
			servers: {},
		};
		const { registry } = harness({
			deps: {
				loadConfig: async (input): Promise<McpConfigResult> => {
					refreshes.push(input.refresh);
					return configResult;
				},
			},
		});
		await registry.initialize();
		expect(registry.getStatuses()).toContainEqual({
			error: "Invalid MCP server configuration",
			name: "websearch",
			state: "failed",
			toolCount: 0,
			transport: "remote",
		});

		configResult = {
			diagnostics: [],
			servers: {
				websearch: serverConfig("websearch", { type: "remote" }),
			},
		};
		await registry.reconnect("websearch");

		expect(registry.getStatuses()).toContainEqual(
			expect.objectContaining({ name: "websearch", state: "connected" })
		);
		expect(refreshes).toEqual([false, true]);
	});

	test("does not duplicate a repaired server during concurrent reconnect and refresh", async () => {
		const invalidConfig: McpConfigResult = {
			diagnostics: [],
			invalidServers: {
				websearch: {
					error: "URL must be absolute http or https URL",
					name: "websearch",
					transport: "remote",
				},
			},
			servers: {},
		};
		const repairedConfig: McpConfigResult = {
			diagnostics: [],
			servers: {
				websearch: serverConfig("websearch", { type: "remote" }),
			},
		};
		let loadCount = 0;
		let releaseReconnectLoad: (() => void) | undefined;
		const clients: FakeMcpClient[] = [];
		const { registry } = harness({
			deps: {
				createClient: (config) => {
					const client = new FakeMcpClient(config.name, [
						tool("web_search_exa"),
					]);
					clients.push(client);
					return client;
				},
				loadConfig: async (): Promise<McpConfigResult> => {
					loadCount += 1;
					if (loadCount === 1) {
						return invalidConfig;
					}
					if (loadCount === 2) {
						return new Promise((resolve) => {
							releaseReconnectLoad = () => resolve(repairedConfig);
						});
					}
					return repairedConfig;
				},
			},
		});
		await registry.initialize();

		const reconnecting = registry.reconnect("websearch");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const refreshing = registry.initialize();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(clients).toHaveLength(0);

		releaseReconnectLoad?.();
		await Promise.all([reconnecting, refreshing]);
		expect(clients).toHaveLength(1);
		expect(registry.getStatuses()).toContainEqual(
			expect.objectContaining({ name: "websearch", state: "connected" })
		);
	});

	test("refreshes a connected server when initialize is called again", async () => {
		let configResult: McpConfigResult = {
			diagnostics: [],
			servers: {
				websearch: serverConfig("websearch", { type: "remote" }),
			},
		};
		const { registry } = harness({
			deps: {
				loadConfig: async (): Promise<McpConfigResult> => configResult,
			},
		});
		await registry.initialize();
		configResult = {
			diagnostics: [],
			invalidServers: {
				websearch: {
					error: "URL must be absolute http or https URL",
					name: "websearch",
					transport: "remote",
				},
			},
			servers: {},
		};

		await registry.initialize();

		expect(registry.getStatuses()).toContainEqual(
			expect.objectContaining({ name: "websearch", state: "failed" })
		);
	});

	test("serializes refresh with an in-flight reconnect for the same server", async () => {
		let config = serverConfig("demo");
		let releaseReconnect: (() => void) | undefined;
		const created: FakeMcpClient[] = [];
		const { registry } = harness({
			deps: {
				createClient: (server) => {
					const client = new FakeMcpClient(server.name, [tool("echo")]);
					created.push(client);
					if (created.length === 2) {
						client.connectImpl = () =>
							new Promise<void>((resolve) => {
								releaseReconnect = resolve;
							});
					}
					return client;
				},
				loadConfig: async (): Promise<McpConfigResult> => ({
					diagnostics: [],
					servers: { demo: config },
				}),
			},
		});
		await registry.initialize();
		const reconnecting = registry.reconnect("demo");
		await new Promise((resolve) => setTimeout(resolve, 0));
		config = serverConfig("demo", { command: ["bun", "x", "demo-next"] });

		const refreshing = registry.initialize();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(created).toHaveLength(2);

		releaseReconnect?.();
		await Promise.all([reconnecting, refreshing]);
		expect(created).toHaveLength(3);
		expect(registry.getStatuses()).toContainEqual(
			expect.objectContaining({ name: "demo", state: "connected" })
		);
	});

	test("does not publish tools from a snapshot racing with disable", async () => {
		const demo = new FakeMcpClient("demo", [tool("echo")]);
		const { registry } = harness({
			clients: { demo },
			configs: [serverConfig("demo")],
		});
		await registry.initialize();

		const snapshotPromise = registry.createSnapshot("build");
		const togglePromise = registry.toggle("demo");
		const [snapshot] = await Promise.all([snapshotPromise, togglePromise]);

		expect(snapshot.manifest).toEqual([]);
		expect(snapshot.tools.size).toBe(0);
		expect(registry.getStatuses()).toContainEqual(
			expect.objectContaining({ name: "demo", state: "disabled" })
		);
	});

	test("disabling aborts an in-flight tool execution", async () => {
		const demo = new FakeMcpClient("demo", [tool("echo")]);
		demo.callImpl = hangingCall();
		const { registry } = harness({
			clients: { demo },
			configs: [serverConfig("demo")],
		});
		const snapshot = await registry.createSnapshot("build");
		const execution = registry.execute(
			snapshot,
			snapshot.manifest[0]?.name ?? "",
			{}
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		await registry.toggle("demo");
		const result = await execution;

		expect(result.isError).toBe(true);
		expect(registry.getStatuses()).toContainEqual(
			expect.objectContaining({ name: "demo", state: "disabled" })
		);
	});

	test("close awaits in-flight init so the SDK client is closed exactly once", async () => {
		const created: FakeMcpClient[] = [];
		const { registry } = harness({
			configs: [serverConfig("demo")],
			deps: {
				createClient: (config) => {
					const client = new FakeMcpClient(config.name, [tool("echo")]);
					created.push(client);
					client.connectImpl = (signal) =>
						new Promise<void>((_resolve, reject) => {
							if (signal?.aborted) {
								reject(new DOMException("Aborted", "AbortError"));
								return;
							}
							signal?.addEventListener("abort", () =>
								reject(new DOMException("Aborted", "AbortError"))
							);
						});
					return client;
				},
			},
		});
		const pending = registry.createSnapshot("build");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(created).toHaveLength(1);
		await registry.close();
		const snapshot = await pending;
		expect(snapshot.manifest).toEqual([]);
		expect(created[0]?.closeCount).toBe(1);
	});

	test("returns a distinct cancelled result when the caller aborts execution", async () => {
		const demo = new FakeMcpClient("demo", [tool("echo")]);
		let callStarted = false;
		const hang = hangingCall();
		demo.callImpl = (name, input, signal) => {
			callStarted = true;
			return hang(name, input, signal);
		};
		const { registry } = harness({
			clients: { demo },
			configs: [serverConfig("demo")],
		});
		const snapshot = await registry.createSnapshot("build");
		const name = snapshot.manifest[0]?.name ?? "";
		const controller = new AbortController();
		const pending = registry.execute(snapshot, name, {}, controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(callStarted).toBe(true);
		controller.abort();
		const result = await pending;
		expect(result.isError).toBe(true);
		const text = JSON.stringify(result.content);
		expect(text).toContain("cancelled");
		expect(text).not.toContain("timed out");
		expect(text).not.toContain("closing");
		expect(demo.closeCount).toBe(0);
		expect(registry.getStatuses()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "demo", state: "connected" }),
			])
		);
	});

	test("reconnect for an unknown server is a no-op", async () => {
		const { registry } = harness({});
		await expect(registry.reconnect("missing")).resolves.toBeUndefined();
	});

	test("orders the manifest deterministically and applies the tool limit", async () => {
		const makeTools = (count: number): McpClientTool[] =>
			Array.from({ length: count }, (_, index) =>
				tool(`t${String(index).padStart(2, "0")}`)
			);
		const serverA = new FakeMcpClient("a", makeTools(100));
		const serverB = new FakeMcpClient("b", makeTools(100));
		const { registry } = harness({
			clients: { a: serverA, b: serverB },
			configs: [serverConfig("b"), serverConfig("a")],
		});
		const snapshot = await registry.createSnapshot("build");
		expect(snapshot.manifest).toHaveLength(128);
		const byServer = snapshot.manifest.map(
			(entry) => snapshot.tools.get(entry.name)?.serverName
		);
		expect(byServer.slice(0, 100)).toEqual(
			Array.from({ length: 100 }, () => "a")
		);
		expect(byServer.slice(100)).toEqual(Array.from({ length: 28 }, () => "b"));
		const originalNames = snapshot.manifest.map(
			(entry) => snapshot.tools.get(entry.name)?.originalToolName
		);
		expect(originalNames).toEqual([
			...serverA.tools.map((item) => item.name),
			...serverB.tools.slice(0, 28).map((item) => item.name),
		]);
	});

	test("notifies subscribers when servers are discovered and settled", async () => {
		const broken = new FakeMcpClient("broken", [tool("echo")]);
		broken.connectFailure = new Error("down");
		let notifications = 0;
		const { registry } = harness({
			clients: { broken },
			configs: [serverConfig("broken")],
		});
		const unsubscribe = registry.subscribe(() => {
			notifications += 1;
		});
		await registry.createSnapshot("build");
		expect(notifications).toBe(2);
		unsubscribe();
		broken.connectFailure = null;
		await registry.reconnect("broken");
		expect(notifications).toBe(2);
	});

	test("close cancels in-flight work, closes clients, and is idempotent", async () => {
		const demo = new FakeMcpClient("demo", [tool("echo")]);
		demo.callImpl = hangingCall();
		const { registry } = harness({
			clients: { demo },
			configs: [serverConfig("demo")],
		});
		const snapshot = await registry.createSnapshot("build");
		const name = snapshot.manifest[0]?.name ?? "";
		const pending = registry.execute(snapshot, name, {});
		await registry.close();
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(demo.closeCount).toBeGreaterThan(0);
		const afterFirstClose = demo.closeCount;
		await registry.close();
		expect(demo.closeCount).toBe(afterFirstClose);
	});
});

describe("agent + server policy composition", () => {
	const findByLogicalName = (
		snapshot: Awaited<ReturnType<McpRegistry["createSnapshot"]>>,
		logicalName: string
	) => {
		for (const entry of snapshot.tools.values()) {
			if (entry.logicalName === logicalName) {
				return entry;
			}
		}
		return;
	};

	const composedPolicy = async (
		serverPolicy: McpExecutionPolicy,
		agentPolicy: McpAgentPolicy
	) => {
		const demo = new FakeMcpClient("demo", [tool("echo")]);
		const { registry } = harness({
			clients: { demo },
			configs: [serverConfig("demo", { permission: serverPolicy })],
		});
		const snapshot = await registry.createSnapshot("build", agentPolicy);
		const entry = findByLogicalName(snapshot, "demo_echo");
		return { entry, snapshot };
	};

	const permissive: McpAgentPolicy = { rules: {}, safety: false };

	const cases: {
		agent: McpAgentPolicy;
		expected: "allow" | "ask" | "deny";
		name: string;
		server: McpExecutionPolicy;
	}[] = [
		{
			agent: permissive,
			expected: "allow",
			name: "allow + allow",
			server: "allow",
		},
		{
			agent: { rules: openRules({ "demo_*": "ask" }), safety: false },
			expected: "ask",
			name: "server allow + agent ask",
			server: "allow",
		},
		{
			agent: permissive,
			expected: "ask",
			name: "server ask + agent allow",
			server: "ask",
		},
		{
			agent: permissive,
			expected: "deny",
			name: "server deny + agent allow",
			server: "deny",
		},
		{
			agent: { rules: openRules({ "*": "deny" }), safety: false },
			expected: "deny",
			name: "server allow + agent deny",
			server: "allow",
		},
		{
			agent: { rules: {}, safety: true },
			expected: "ask",
			name: "safety ceiling turns allow into ask",
			server: "allow",
		},
		{
			agent: { rules: openRules({ "*": "deny" }), safety: true },
			expected: "deny",
			name: "safety ceiling never loosens a deny",
			server: "allow",
		},
	];

	for (const { agent, expected, name, server } of cases) {
		test(`composes ${name} to ${expected}`, async () => {
			const { entry, snapshot } = await composedPolicy(server, agent);
			expect(entry?.policy).toBe(expected);
			// Only non-deny tools reach the manifest the model sees.
			expect(snapshot.manifest.length).toBe(expected === "deny" ? 0 : 1);
		});
	}
});
