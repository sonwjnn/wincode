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
import type { McpConfigResult, ResolvedMcpServerConfig } from "./config";
import type { McpPolicyResult } from "./policy";
import {
	createMcpRegistry,
	type McpCatalogSnapshot,
	type McpRegistry,
} from "./registry";

const FIXTURE = path.join(import.meta.dir, "fixtures", "stdio-server.ts");

const timeouts = {
	startup: 5000,
	catalog: 5000,
	execution: 10_000,
} as const;

const stdioServerConfig = (
	name: string,
	command: string[]
): ResolvedMcpServerConfig => ({
	name,
	type: "local",
	command,
	cwd: import.meta.dir,
	disabled: false,
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
	timeout: timeouts,
});

// Real registry with the production SDK client factory wiring; only the
// file-based config/policy loaders are injected so the tests point at the
// real transports without touching the user's opencode.json/.wincode/mcp.json.
const createRegistry = (config: ResolvedMcpServerConfig): McpRegistry =>
	createMcpRegistry({
		env: { ...process.env },
		globalRoot: path.join(import.meta.dir, ".integration-global"),
		workspace: import.meta.dir,
		loadConfig: async (): Promise<McpConfigResult> => ({
			diagnostics: [],
			servers: { [config.name]: config },
		}),
		loadPolicy: async (): Promise<McpPolicyResult> => ({
			diagnostics: [],
			policy: { servers: { [config.name]: "allow" } },
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
			expect(snapshot.mode).toBe("build");
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
			const result = await registry.execute(
				snapshot,
				echoToolName(snapshot),
				{ text: "hello transport" },
				async () => true
			);
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
			const result = await registry.execute(
				snapshot,
				echoToolName(snapshot),
				{ text: "hello over http" },
				async () => true
			);
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
