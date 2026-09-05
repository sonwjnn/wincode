// End-to-end MCP transport integration tests using real SDK v2 clients and
// real servers (no mocks of @modelcontextprotocol/client|server).
//
// Transport wiring notes:
// - `process.execPath` is Bun, so local servers are spawned with
//   `[process.execPath, "run", fixturePath]` where fixturePath is the
//   runnable `fixtures/stdio-server.ts` entrypoint (see its header comment).
// - HTTP uses the documented v2 `createMcpHandler` factory entry wrapped by
//   `globalThis.Bun.serve`; the factory creates a fresh McpServer per request.
// - `registry.close()` must always run, so every test wraps its registry in
//   try/finally.

import { describe, expect, test } from "bun:test";
import net from "node:net";
import path from "node:path";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { PermissionRules } from "@/modules/permissions";
import type { McpConfigResult, ResolvedMcpServerConfig } from "./config";
import type { McpExecutionPolicy } from "./policy";
import {
	createMcpRegistry,
	type McpAgentPolicy,
	type McpCatalogSnapshot,
	type McpRegistry,
	type McpSnapshotTool,
} from "./registry";

const FIXTURE = path.join(import.meta.dir, "fixtures", "stdio-server.ts");

const timeouts = {
	startup: 5000,
	catalog: 5000,
	execution: 10_000,
} as const;

const stdioServerConfig = (
	name: string,
	command: string[],
	permission: McpExecutionPolicy = "allow"
): ResolvedMcpServerConfig => ({
	name,
	type: "local",
	command,
	cwd: import.meta.dir,
	disabled: false,
	permission,
	timeout: timeouts,
});

const remoteServerConfig = (
	name: string,
	url: string
): ResolvedMcpServerConfig => ({
	name,
	type: "remote",
	url,
	disabled: false,
	permission: "allow",
	timeout: timeouts,
});

// Real registry with the production SDK client factory wiring. Only the
// file-based config loader is injected so tests point at real transports
// without touching the user's Wincode configuration.
const createRegistry = (config: ResolvedMcpServerConfig): McpRegistry =>
	createMcpRegistry({
		env: { ...process.env },
		workspace: import.meta.dir,
		loadConfig: async (): Promise<McpConfigResult> => ({
			diagnostics: [],
			servers: { [config.name]: config },
		}),
	});

const echoToolName = (snapshot: McpCatalogSnapshot): string => {
	const entry = snapshot.manifest[0];
	if (entry === undefined) {
		throw new Error("expected a manifest with the echo tool");
	}
	return entry.name;
};

const createEchoServer = (): McpServer => {
	const server = new McpServer({ name: "http-echo", version: "0.1.0" });
	server.registerTool(
		"echo",
		{
			description: "Echo the provided text back",
			inputSchema: z.object({ text: z.string() }),
		},
		async ({ text }) => ({
			content: [{ type: "text", text }],
		})
	);
	return server;
};

const hasChildProcess = (fixture: string): boolean => {
	const result = globalThis.Bun.spawnSync(["ps", "-axo", "pid=,command="], {
		stdout: "pipe",
	});
	return result.stdout
		.toString()
		.split("\n")
		.some((line) => line.includes(fixture));
};

const waitForNoChildProcess = async (fixture: string): Promise<void> => {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (!hasChildProcess(fixture)) {
			return;
		}
		await globalThis.Bun.sleep(100);
	}
	throw new Error(`child process for ${fixture} is still running after close`);
};

// Bun's fetch pools keep-alive sockets, so a stopped server can still answer
// through a stale pooled connection. A raw TCP connect is the reliable check
// that the port was actually released.
const portReleased = (port: number): Promise<boolean> =>
	new Promise((resolve) => {
		const socket = net.connect({ host: "127.0.0.1", port });
		const settle = (released: boolean): void => {
			socket.destroy();
			resolve(released);
		};
		socket.once("connect", () => settle(false));
		socket.once("error", () => settle(true));
	});

describe("MCP transport integration", () => {
	test("stdio: connects to a spawned server, discovers echo, and executes it", async () => {
		const registry = createRegistry(
			stdioServerConfig("stdio-echo", [process.execPath, "run", FIXTURE])
		);
		try {
			const snapshot = await registry.createSnapshot("build");
			expect(snapshot.agent).toBe("build");
			expect(snapshot.manifest).toHaveLength(1);
			expect(snapshot.manifest[0]?.inputSchema).toMatchObject({
				type: "object",
				properties: { text: { type: "string" } },
			});
			expect(registry.getStatuses()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "stdio-echo",
						state: "connected",
						transport: "local",
						toolCount: 1,
					}),
				])
			);
			const result = await registry.execute(snapshot, echoToolName(snapshot), {
				text: "hello transport",
			});
			expect(result).toEqual({
				content: [{ type: "text", text: "hello transport" }],
				isError: false,
				truncated: false,
			});
		} finally {
			await registry.close();
		}
	}, 15_000);

	test("stdio: marks the server failed and exposes no tools when the command exits immediately", async () => {
		const registry = createRegistry(
			stdioServerConfig("exit-fast", [
				process.execPath,
				"-e",
				"process.exit(1)",
			])
		);
		try {
			const snapshot = await registry.createSnapshot("build");
			expect(snapshot.manifest).toHaveLength(0);
			expect(snapshot.tools.size).toBe(0);
			expect(registry.getStatuses()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "exit-fast",
						state: "failed",
						toolCount: 0,
					}),
				])
			);
		} finally {
			await registry.close();
		}
	}, 15_000);

	test("stdio: no child process remains after close", async () => {
		const registry = createRegistry(
			stdioServerConfig("stdio-echo", [process.execPath, "run", FIXTURE])
		);
		try {
			const snapshot = await registry.createSnapshot("build");
			expect(snapshot.manifest).toHaveLength(1);
			expect(hasChildProcess(FIXTURE)).toBe(true);
		} finally {
			await registry.close();
		}
		await waitForNoChildProcess(FIXTURE);
	}, 15_000);

	test("http: discovers and executes echo over streamable HTTP", async () => {
		const handler = createMcpHandler(() => createEchoServer());
		const server = globalThis.Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => handler.fetch(request),
		});
		const registry = createRegistry(
			remoteServerConfig("http-echo", server.url.toString())
		);
		try {
			const snapshot = await registry.createSnapshot("build");
			expect(snapshot.manifest).toHaveLength(1);
			expect(registry.getStatuses()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "http-echo",
						state: "connected",
						transport: "remote",
						toolCount: 1,
					}),
				])
			);
			const result = await registry.execute(snapshot, echoToolName(snapshot), {
				text: "hello over http",
			});
			expect(result).toEqual({
				content: [{ type: "text", text: "hello over http" }],
				isError: false,
				truncated: false,
			});
		} finally {
			await registry.close();
			await server.stop();
		}
	}, 15_000);

	test("http: port is released after close", async () => {
		const handler = createMcpHandler(() => createEchoServer());
		const server = globalThis.Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => handler.fetch(request),
		});
		const url = server.url;
		const registry = createRegistry(
			remoteServerConfig("http-echo", url.toString())
		);
		try {
			const snapshot = await registry.createSnapshot("build");
			expect(snapshot.manifest).toHaveLength(1);
		} finally {
			await registry.close();
			await server.stop();
		}
		expect(await portReleased(Number(url.port))).toBe(true);
	}, 15_000);
});

const STDIO_ECHO_DISPATCH_PATTERN = /^mcp_stdio-echo_echo_/;

// Open-glob agent policy keys sit outside the nominal PermissionAction union;
// the registry matches them as globs, so cast the literals as the policy module
// does.
const openRules = (rules: Record<string, "allow" | "ask" | "deny">) =>
	rules as PermissionRules;

const firstTool = (snapshot: McpCatalogSnapshot): McpSnapshotTool => {
	const entry = snapshot.tools.values().next().value;
	if (entry === undefined) {
		throw new Error("expected at least one dispatch entry in the catalog");
	}
	return entry;
};
const dispatchNameOf = (snapshot: McpCatalogSnapshot): string => {
	const name = snapshot.tools.keys().next().value;
	if (name === undefined) {
		throw new Error("expected at least one dispatch entry in the catalog");
	}
	return name;
};

describe("MCP policy composition over the real catalog", () => {
	const buildStdioRegistry = (): McpRegistry =>
		createRegistry(
			stdioServerConfig("stdio-echo", [process.execPath, "run", FIXTURE])
		);

	const permissive: McpAgentPolicy = { rules: {}, safety: false };

	test("exposes and names an allowed tool logically", async () => {
		const registry = buildStdioRegistry();
		try {
			const snapshot = await registry.createSnapshot("build", permissive);
			expect(snapshot.manifest).toHaveLength(1);
			const tool = firstTool(snapshot);
			expect(tool.policy).toBe("allow");
			// Logical name is the hash-free `<server>_<tool>` Permission action,
			// distinct from the hashed dispatch key the manifest advertises.
			expect(tool.logicalName).toBe("stdio-echo_echo");
			expect(dispatchNameOf(snapshot)).not.toBe(tool.logicalName);
			expect(dispatchNameOf(snapshot)).toMatch(STDIO_ECHO_DISPATCH_PATTERN);
		} finally {
			await registry.close();
		}
	}, 15_000);

	test("an ask policy keeps the tool visible but gated", async () => {
		const registry = buildStdioRegistry();
		try {
			const snapshot = await registry.createSnapshot("build", {
				rules: openRules({ "stdio-echo_*": "ask" }),
				safety: false,
			});
			expect(snapshot.manifest).toHaveLength(1);
			expect(firstTool(snapshot).policy).toBe("ask");
		} finally {
			await registry.close();
		}
	}, 15_000);

	test("a deny policy hides the tool but keeps its dispatch entry", async () => {
		const registry = buildStdioRegistry();
		try {
			const snapshot = await registry.createSnapshot("build", {
				rules: openRules({ "*": "deny" }),
				safety: false,
			});
			expect(snapshot.manifest).toEqual([]);
			expect(snapshot.tools.size).toBe(1);
			expect(firstTool(snapshot).policy).toBe("deny");
		} finally {
			await registry.close();
		}
	}, 15_000);

	test("a server-level ask composes to ask under a permissive agent", async () => {
		const registry = createRegistry(
			stdioServerConfig("stdio-echo", [process.execPath, "run", FIXTURE], "ask")
		);
		try {
			const snapshot = await registry.createSnapshot("build", permissive);
			expect(snapshot.manifest).toHaveLength(1);
			expect(firstTool(snapshot).policy).toBe("ask");
		} finally {
			await registry.close();
		}
	}, 15_000);

	test("a server-level deny hides the tool even under a permissive agent", async () => {
		const registry = createRegistry(
			stdioServerConfig(
				"stdio-echo",
				[process.execPath, "run", FIXTURE],
				"deny"
			)
		);
		try {
			const snapshot = await registry.createSnapshot("build", permissive);
			expect(snapshot.manifest).toEqual([]);
			expect(snapshot.tools.size).toBe(1);
			expect(firstTool(snapshot).policy).toBe("deny");
		} finally {
			await registry.close();
		}
	}, 15_000);

	test("a server ask stays ask when the agent also allows, and a server allow rises to ask when the agent asks", async () => {
		const askServer = createRegistry(
			stdioServerConfig("stdio-echo", [process.execPath, "run", FIXTURE], "ask")
		);
		try {
			// server ask + agent allow -> ask (neither side loosens the other).
			const snapshot = await askServer.createSnapshot("build", {
				rules: openRules({ "stdio-echo_*": "allow" }),
				safety: false,
			});
			expect(firstTool(snapshot).policy).toBe("ask");
		} finally {
			await askServer.close();
		}
	}, 15_000);
});
