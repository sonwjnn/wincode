import { describe, expect, test } from "bun:test";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import {
	createSdkMcpClient,
	McpClientError,
	type McpClientFactoryDeps,
	type McpClientTool,
} from "./client";
import type {
	LocalMcpServerConfig,
	RemoteMcpServerConfig,
	ResolvedMcpServerConfig,
} from "./config";

type FakeClient = {
	close(): Promise<void>;
	connect(
		transport: unknown,
		options?: { signal?: AbortSignal }
	): Promise<void>;
	listTools(
		params?: unknown,
		options?: { signal?: AbortSignal }
	): Promise<{ tools: Tool[] }>;
	callTool(
		params: { name: string; arguments?: unknown },
		options?: { signal?: AbortSignal }
	): Promise<CallToolResult>;
};

const fakeTransport = {
	close: async () => {
		return;
	},
	start: async () => {
		return;
	},
};
const fakeClient = (): FakeClient => ({
	close: async () => {
		return;
	},
	connect: async () => {
		return;
	},
	listTools: async () => ({ tools: [] }),
	callTool: async () => ({ content: [] }),
});
const rejectedMcpError = async (
	promise: Promise<unknown>
): Promise<McpClientError> => {
	try {
		await promise;
	} catch (error) {
		if (error instanceof McpClientError) {
			return error;
		}
		throw new Error("expected McpClientError rejection", { cause: error });
	}
	throw new Error("expected rejection");
};
const failHttp: McpClientFactoryDeps["createHttpTransport"] = () => {
	throw new Error("unexpected http transport");
};
const failStdio: McpClientFactoryDeps["createStdioTransport"] = () => {
	throw new Error("unexpected stdio transport");
};
const tool = (name: string, patch: Partial<Tool> = {}): Tool => ({
	name,
	inputSchema: { type: "object" },
	...patch,
});
const baseLocal: LocalMcpServerConfig = {
	name: "demo",
	type: "local",
	command: ["bun", "x", "demo"],
	disabled: false,
	permission: "ask",
	timeout: { startup: 30_000, catalog: 30_000, execution: 43_200_000 },
};
const baseRemote: RemoteMcpServerConfig = {
	name: "remote-demo",
	type: "remote",
	url: "https://mcp.example.com/mcp",
	disabled: false,
	permission: "ask",
	timeout: { startup: 30_000, catalog: 30_000, execution: 43_200_000 },
};
const localConfig = (
	patch: Partial<LocalMcpServerConfig> = {}
): ResolvedMcpServerConfig => ({ ...baseLocal, ...patch });
const remoteConfig = (
	patch: Partial<RemoteMcpServerConfig> = {}
): ResolvedMcpServerConfig => ({ ...baseRemote, ...patch });
const baseDeps = (
	overrides: Partial<McpClientFactoryDeps> = {}
): McpClientFactoryDeps => ({
	environment: {},
	workspace: "/workspace",
	createClient: () => fakeClient(),
	createStdioTransport: () => fakeTransport,
	createHttpTransport: () => fakeTransport,
	createStartupSignal: () => new AbortController().signal,
	...overrides,
});

describe("createSdkMcpClient", () => {
	test("constructs local stdio transport from argv without shell", async () => {
		const transports: unknown[] = [];
		const adapter = createSdkMcpClient(
			localConfig({ cwd: "/workspace", environment: { LOG_LEVEL: "info" } }),
			baseDeps({
				environment: { PATH: "/bin" },
				createStdioTransport: (options) => {
					transports.push(options);
					return fakeTransport;
				},
				createHttpTransport: failHttp,
			})
		);
		await adapter.connect();
		expect(transports).toEqual([
			{
				args: ["x", "demo"],
				command: "bun",
				cwd: "/workspace",
				env: { LOG_LEVEL: "info", PATH: "/bin" },
				stderr: "ignore",
			},
		]);
	});

	test("resolves relative cwd against the workspace and normalizes it", async () => {
		const transports: unknown[] = [];
		const adapter = createSdkMcpClient(
			localConfig({ cwd: "./tools/../servers" }),
			baseDeps({
				workspace: "/workspace/project",
				createStdioTransport: (options) => {
					transports.push(options);
					return fakeTransport;
				},
				createHttpTransport: failHttp,
			})
		);
		await adapter.connect();
		expect(transports[0]).toMatchObject({ cwd: "/workspace/project/servers" });
	});

	test("keeps absolute cwd as-is", async () => {
		const transports: unknown[] = [];
		const adapter = createSdkMcpClient(
			localConfig({ cwd: "/abs/custom" }),
			baseDeps({
				workspace: "/workspace",
				createStdioTransport: (options) => {
					transports.push(options);
					return fakeTransport;
				},
				createHttpTransport: failHttp,
			})
		);
		await adapter.connect();
		expect(transports[0]).toMatchObject({ cwd: "/abs/custom" });
	});

	test("merges inherited environment with overrides where overrides win", async () => {
		const transports: unknown[] = [];
		const adapter = createSdkMcpClient(
			localConfig({
				environment: { LOG_LEVEL: "info", OVERRIDE: "server" },
			}),
			baseDeps({
				environment: { PATH: "/bin", OVERRIDE: "process" },
				createStdioTransport: (options) => {
					transports.push(options);
					return fakeTransport;
				},
				createHttpTransport: failHttp,
			})
		);
		await adapter.connect();
		expect(transports[0]).toMatchObject({
			env: { PATH: "/bin", LOG_LEVEL: "info", OVERRIDE: "server" },
		});
	});

	test("constructs remote transport from url and requestInit headers only", async () => {
		const httpCalls: {
			url: URL;
			options: { requestInit: { headers: Record<string, string> } };
		}[] = [];
		const adapter = createSdkMcpClient(
			remoteConfig({
				url: "https://mcp.example.com/mcp",
				headers: { Authorization: "Bearer abc", "X-Key": "v" },
			}),
			baseDeps({
				createStdioTransport: failStdio,
				createHttpTransport: (url, options) => {
					httpCalls.push({ url, options });
					return fakeTransport;
				},
			})
		);
		await adapter.connect();
		expect(httpCalls).toHaveLength(1);
		expect(httpCalls[0]?.url).toBeInstanceOf(URL);
		expect(httpCalls[0]?.url.toString()).toBe("https://mcp.example.com/mcp");
		expect(httpCalls[0]?.options).toEqual({
			requestInit: {
				headers: { Authorization: "Bearer abc", "X-Key": "v" },
			},
		});
	});

	test("remote without headers sends an empty header record", async () => {
		const httpCalls: { options: unknown }[] = [];
		const adapter = createSdkMcpClient(
			remoteConfig(),
			baseDeps({
				createStdioTransport: failStdio,
				createHttpTransport: (_url, options) => {
					httpCalls.push({ options });
					return fakeTransport;
				},
			})
		);
		await adapter.connect();
		expect(httpCalls[0]?.options).toEqual({
			requestInit: { headers: {} },
		});
	});

	test("registers listChanged handler and forwards refreshed tools to set listener", async () => {
		let capturedOnChanged:
			| ((error: Error | null, tools: Tool[] | null) => void)
			| undefined;
		const received: McpClientTool[][] = [];
		const adapter = createSdkMcpClient(
			localConfig(),
			baseDeps({
				createClient: (options) => {
					capturedOnChanged = options.listChanged.tools.onChanged;
					return fakeClient();
				},
				createHttpTransport: failHttp,
			})
		);
		adapter.setToolsChangedListener((tools) => {
			received.push([...tools]);
		});
		expect(capturedOnChanged).toBeUndefined();
		await adapter.connect();
		expect(capturedOnChanged).toBeTypeOf("function");
		capturedOnChanged?.(null, [tool("a", { description: "A" }), tool("b")]);
		expect(received).toEqual([
			[
				{ name: "a", description: "A", inputSchema: { type: "object" } },
				{ name: "b", inputSchema: { type: "object" } },
			],
		]);
	});

	test("does not forward listChanged errors to the listener", async () => {
		let capturedOnChanged:
			| ((error: Error | null, tools: Tool[] | null) => void)
			| undefined;
		const received: McpClientTool[][] = [];
		const adapter = createSdkMcpClient(
			localConfig(),
			baseDeps({
				createClient: (options) => {
					capturedOnChanged = options.listChanged.tools.onChanged;
					return fakeClient();
				},
				createHttpTransport: failHttp,
			})
		);
		adapter.setToolsChangedListener((tools) => {
			received.push([...tools]);
		});
		await adapter.connect();
		capturedOnChanged?.(new Error("refresh failed"), null);
		expect(received).toEqual([]);
	});

	test("connect delegates to the SDK client with transport and startup signal", async () => {
		const startup = new AbortController().signal;
		const calls: { transport: unknown; signal?: AbortSignal }[] = [];
		const adapter = createSdkMcpClient(
			localConfig(),
			baseDeps({
				createStartupSignal: () => startup,
				createClient: () => ({
					close: async () => {
						return;
					},
					connect: (transport, options) => {
						calls.push({ transport, signal: options?.signal });
						return Promise.resolve();
					},
					listTools: async () => ({ tools: [] }),
					callTool: async () => ({ content: [] }),
				}),
				createHttpTransport: failHttp,
			})
		);
		await adapter.connect();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.transport).toBe(fakeTransport);
		expect(calls[0]?.signal).toBe(startup);
	});

	test("combines a caller signal with the startup signal", async () => {
		const callerSignal = new AbortController().signal;
		const calls: { signal?: AbortSignal }[] = [];
		const adapter = createSdkMcpClient(
			localConfig(),
			baseDeps({
				createClient: () => ({
					close: async () => {
						return;
					},
					connect: (_transport, options) => {
						calls.push({ signal: options?.signal });
						return Promise.resolve();
					},
					listTools: async () => ({ tools: [] }),
					callTool: async () => ({ content: [] }),
				}),
				createHttpTransport: failHttp,
			})
		);
		await adapter.connect(callerSignal);
		const combined = calls[0]?.signal;
		expect(combined).toBeInstanceOf(AbortSignal);
		expect(combined?.aborted).toBe(false);
		callerSignal.dispatchEvent(new Event("abort"));
	});

	test("times out connect with a sanitized error naming the server", async () => {
		const timeouts: number[] = [];
		const adapter = createSdkMcpClient(
			localConfig({
				timeout: { startup: 1, catalog: 30_000, execution: 43_200_000 },
			}),
			baseDeps({
				createStartupSignal: (timeoutMs) => {
					timeouts.push(timeoutMs);
					return AbortSignal.abort();
				},
				createClient: () => ({
					close: async () => {
						return;
					},
					connect: (_transport, options) =>
						options?.signal?.aborted
							? Promise.reject(new DOMException("Aborted", "AbortError"))
							: Promise.resolve(),
					listTools: async () => ({ tools: [] }),
					callTool: async () => ({ content: [] }),
				}),
				createHttpTransport: failHttp,
			})
		);
		const error = await rejectedMcpError(adapter.connect());
		expect(timeouts).toEqual([1]);
		expect(error).toMatchObject({
			serverName: "demo",
			message: "demo: connect timed out",
		});
	});

	test("sanitizes remote connect errors so headers, url, and secrets never leak", async () => {
		const adapter = createSdkMcpClient(
			remoteConfig({
				url: "https://secret-host.example/mcp",
				headers: { Authorization: "Bearer super-secret-token" },
			}),
			baseDeps({
				createStdioTransport: failStdio,
				createClient: () => ({
					close: async () => {
						return;
					},
					connect: () =>
						Promise.reject(
							new Error(
								"auth failed at https://secret-host.example/mcp with Bearer super-secret-token"
							)
						),
					listTools: async () => ({ tools: [] }),
					callTool: async () => ({ content: [] }),
				}),
			})
		);
		const error = await rejectedMcpError(adapter.connect());
		expect(error).toMatchObject({ serverName: "remote-demo" });
		expect(error.message).toContain("remote-demo");
		expect(error.message).not.toContain("super-secret-token");
		expect(error.message).not.toContain("secret-host.example");
		expect(error.message).not.toContain("Bearer");
	});

	test("sanitizes local connect errors so env values never leak", async () => {
		const adapter = createSdkMcpClient(
			localConfig({ environment: { API_KEY: "env-super-secret" } }),
			baseDeps({
				createClient: () => ({
					close: async () => {
						return;
					},
					connect: () =>
						Promise.reject(new Error("failed with env-super-secret")),
					listTools: async () => ({ tools: [] }),
					callTool: async () => ({ content: [] }),
				}),
				createHttpTransport: failHttp,
			})
		);
		const error = await rejectedMcpError(adapter.connect());
		expect(error.message).toContain("demo");
		expect(error.message).not.toContain("env-super-secret");
	});

	test("listTools delegates to the SDK and maps to the narrow tool shape", async () => {
		const signal = new AbortController().signal;
		const calls: { signal?: AbortSignal }[] = [];
		const adapter = createSdkMcpClient(
			localConfig(),
			baseDeps({
				createClient: () => ({
					close: async () => {
						return;
					},
					connect: async () => {
						return;
					},
					listTools: (_params, options) => {
						calls.push(options ?? {});
						return Promise.resolve({
							tools: [tool("a", { description: "A" }), tool("b")],
						});
					},
					callTool: async () => ({ content: [] }),
				}),
				createHttpTransport: failHttp,
			})
		);
		const result = await adapter.listTools(signal);
		expect(result).toEqual([
			{ name: "a", description: "A", inputSchema: { type: "object" } },
			{ name: "b", inputSchema: { type: "object" } },
		]);
		expect(calls).toEqual([{ signal }]);
	});

	test("callTool delegates name and arguments and returns the SDK result", async () => {
		const signal = new AbortController().signal;
		const result: CallToolResult = {
			content: [{ type: "text", text: "ok" }],
			isError: false,
		};
		const calls: {
			params: { name: string; arguments?: unknown };
			signal?: AbortSignal;
		}[] = [];
		const adapter = createSdkMcpClient(
			localConfig(),
			baseDeps({
				createClient: () => ({
					close: async () => {
						return;
					},
					connect: async () => {
						return;
					},
					listTools: async () => ({ tools: [] }),
					callTool: (params, options) => {
						calls.push({ params, signal: options?.signal });
						return Promise.resolve(result);
					},
				}),
				createHttpTransport: failHttp,
			})
		);
		await expect(
			adapter.callTool("echo", { text: "hi" }, signal)
		).resolves.toBe(result);
		expect(calls).toEqual([
			{ params: { name: "echo", arguments: { text: "hi" } }, signal },
		]);
	});

	test("listTools sanitizes thrown errors so tokens and urls never leak", async () => {
		const adapter = createSdkMcpClient(
			remoteConfig({
				url: "https://x",
				headers: { Authorization: "Bearer leaked-token" },
			}),
			baseDeps({
				createStdioTransport: failStdio,
				createClient: () => ({
					close: async () => {
						return;
					},
					connect: async () => {
						return;
					},
					listTools: () =>
						Promise.reject(new Error("Bearer leaked-token https://x")),
					callTool: async () => ({ content: [] }),
				}),
			})
		);
		const error = await rejectedMcpError(adapter.listTools());
		expect(error).toMatchObject({ serverName: "remote-demo" });
		expect(error.message).toContain("remote-demo");
		expect(error.message).not.toContain("leaked-token");
		expect(error.message).not.toContain("https://x");
		expect(error.message).not.toContain("Bearer");
	});

	test("callTool sanitizes thrown errors so tokens and urls never leak", async () => {
		const adapter = createSdkMcpClient(
			remoteConfig({
				url: "https://x",
				headers: { Authorization: "Bearer leaked-token" },
			}),
			baseDeps({
				createStdioTransport: failStdio,
				createClient: () => ({
					close: async () => {
						return;
					},
					connect: async () => {
						return;
					},
					listTools: async () => ({ tools: [] }),
					callTool: () =>
						Promise.reject(new Error("Bearer leaked-token https://x")),
				}),
			})
		);
		const error = await rejectedMcpError(
			adapter.callTool("echo", { text: "hi" })
		);
		expect(error).toMatchObject({ serverName: "remote-demo" });
		expect(error.message).toContain("remote-demo");
		expect(error.message).not.toContain("leaked-token");
		expect(error.message).not.toContain("https://x");
		expect(error.message).not.toContain("Bearer");
	});

	test("close delegates to the SDK client", async () => {
		let closed = 0;
		const adapter = createSdkMcpClient(
			localConfig(),
			baseDeps({
				createClient: () => ({
					close: async () => {
						closed += 1;
					},
					connect: async () => {
						return;
					},
					listTools: async () => ({ tools: [] }),
					callTool: async () => ({ content: [] }),
				}),
				createHttpTransport: failHttp,
			})
		);
		await adapter.close();
		expect(closed).toBe(1);
	});

	test("close sanitizes thrown errors so env secrets never leak", async () => {
		const adapter = createSdkMcpClient(
			localConfig({ environment: { API_KEY: "close-super-secret" } }),
			baseDeps({
				createClient: () => ({
					close: () =>
						Promise.reject(
							new Error("shutdown failed with close-super-secret")
						),
					connect: async () => {
						return;
					},
					listTools: async () => ({ tools: [] }),
					callTool: async () => ({ content: [] }),
				}),
				createHttpTransport: failHttp,
			})
		);
		const error = await rejectedMcpError(adapter.close());
		expect(error).toMatchObject({ serverName: "demo" });
		expect(error.message).toContain("demo");
		expect(error.message).not.toContain("close-super-secret");
	});
});
