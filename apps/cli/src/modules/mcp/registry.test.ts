import { describe, expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/client";
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
	type McpApprovalRequest,
	type McpRegistry,
	type McpRegistryDeps,
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

const ECHO_NAME_PATTERN = /^mcp_demo_echo_/;

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
	test("returns an empty plan snapshot without connecting", async () => {
		const { clients, registry } = harness({
			configs: [serverConfig("demo")],
		});
		const snapshot = await registry.createSnapshot("plan");
		expect(snapshot.mode).toBe("plan");
		expect(snapshot.manifest).toEqual([]);
		expect(snapshot.tools.size).toBe(0);
		expect(clients.size).toBe(0);
		expect(registry.getStatuses()).toEqual([]);
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
		const result = await registry.execute(
			snapshot,
			readName ?? "",
			{},
			async () => true
		);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("denied");
	});

	test("asks for approval exactly once and includes request details", async () => {
		const demo = new FakeMcpClient("demo", [tool("echo", "Echo text back")]);
		const { registry } = harness({
			clients: { demo },
			configs: [serverConfig("demo", { permission: "ask" })],
		});
		const snapshot = await registry.createSnapshot("build");
		const name = snapshot.manifest[0]?.name ?? "";
		expect(name).toMatch(ECHO_NAME_PATTERN);
		const requests: McpApprovalRequest[] = [];
		const result = await registry.execute(
			snapshot,
			name,
			{ text: "hi" },
			async (request) => {
				requests.push(request);
				return true;
			}
		);
		expect(result.isError).toBe(false);
		expect(requests).toEqual([
			{
				serverName: "demo",
				originalToolName: "echo",
				description: "Echo text back",
				input: { text: "hi" },
			},
		]);
	});

	test("returns an output error when approval is denied", async () => {
		const demo = new FakeMcpClient("demo", [tool("echo")]);
		const { registry } = harness({
			clients: { demo },
			configs: [serverConfig("demo", { permission: "ask" })],
		});
		const snapshot = await registry.createSnapshot("build");
		const name = snapshot.manifest[0]?.name ?? "";
		const result = await registry.execute(
			snapshot,
			name,
			{},
			async () => false
		);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("not approved");
	});

	test("bypasses approval when the policy allows", async () => {
		const demo = new FakeMcpClient("demo", [tool("echo")]);
		const { registry } = harness({
			clients: { demo },
			configs: [serverConfig("demo", { permission: "allow" })],
		});
		const snapshot = await registry.createSnapshot("build");
		const name = snapshot.manifest[0]?.name ?? "";
		const result = await registry.execute(snapshot, name, {}, async () => {
			throw new Error("approval must not be requested");
		});
		expect(result.isError).toBe(false);
	});

	test("re-asks for approval on every call instead of reusing a decision", async () => {
		const demo = new FakeMcpClient("demo", [tool("echo")]);
		const { registry } = harness({
			clients: { demo },
			configs: [serverConfig("demo", { permission: "ask" })],
		});
		const snapshot = await registry.createSnapshot("build");
		const name = snapshot.manifest[0]?.name ?? "";
		let approvals = 0;
		const approve = async (): Promise<boolean> => {
			approvals += 1;
			return true;
		};
		await registry.execute(snapshot, name, {}, approve);
		await registry.execute(snapshot, name, {}, approve);
		expect(approvals).toBe(2);
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
		const result = await registry.execute(snapshot, name, {}, async () => true);
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
		const result = await registry.execute(snapshot, name, {}, async () => true);
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
			{},
			async () => true
		);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("Unknown");
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
		const result = await registry.execute(first, name, {}, async () => true);
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
		const result = await registry.execute(
			first,
			firstName,
			{},
			async () => true
		);
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
		const pending = registry.execute(snapshot, name, {}, async () => true);
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
		const snapshot = await registry.createSnapshot("build");
		expect(snapshot.manifest).toHaveLength(1);
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
		demo.callImpl = hangingCall();
		const { registry } = harness({
			clients: { demo },
			configs: [serverConfig("demo")],
		});
		const snapshot = await registry.createSnapshot("build");
		const name = snapshot.manifest[0]?.name ?? "";
		const controller = new AbortController();
		const pending = registry.execute(
			snapshot,
			name,
			{},
			async () => true,
			controller.signal
		);
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

	test("notifies subscribers once per init batch and supports unsubscribe", async () => {
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
		expect(notifications).toBe(1);
		unsubscribe();
		broken.connectFailure = null;
		await registry.reconnect("broken");
		expect(notifications).toBe(1);
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
		const pending = registry.execute(snapshot, name, {}, async () => true);
		await registry.close();
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(demo.closeCount).toBeGreaterThan(0);
		const afterFirstClose = demo.closeCount;
		await registry.close();
		expect(demo.closeCount).toBe(afterFirstClose);
	});
});
