import { expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { testRender } from "@opentui/react/test-utils";
import type { ModeType } from "@wincode/ai";
import { act } from "react";
import { DialogProvider } from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import type { McpClient, McpClientTool } from "../client";
import type {
	McpApprovalRequest,
	McpCatalogSnapshot,
	McpRegistry,
	McpServerStatus,
	McpSnapshotTool,
} from "../registry";
import type { McpNormalizedResult } from "../result";
import {
	createMcpApprovalController,
	type McpAddToolOutput,
	type McpApprovalController,
	type McpContextValue,
	type McpDynamicToolCall,
	McpProvider,
	type McpToolOutputConfig,
	runDynamicToolCall,
	useMcp,
} from "./mcp-provider";

class FakeMcpClient implements McpClient {
	async callTool(): Promise<CallToolResult> {
		return { content: [] };
	}

	async close(): Promise<void> {
		// no-op stub
	}

	async connect(): Promise<void> {
		// no-op stub
	}

	async listTools(): Promise<readonly McpClientTool[]> {
		return [];
	}

	setToolsChangedListener(
		_listener: (tools: readonly McpClientTool[]) => void
	): void {
		// no-op stub
	}
}

const successResult = (): McpNormalizedResult => ({
	content: [{ type: "text", text: "ok" }],
	isError: false,
	truncated: false,
});

const makeRequest = (): McpApprovalRequest => ({
	description: "A demo tool",
	input: { text: "hello" },
	originalToolName: "echo",
	serverName: "demo",
});

const makeTool = (
	overrides: Partial<McpSnapshotTool> = {}
): McpSnapshotTool => ({
	client: new FakeMcpClient(),
	description: "A demo tool",
	originalToolName: "echo",
	policy: "allow",
	serverName: "demo",
	...overrides,
});

const makeSnapshot = (
	overrides: Partial<McpCatalogSnapshot> = {}
): McpCatalogSnapshot => ({
	id: "snap-1",
	manifest: [],
	mode: "build",
	tools: new Map([["mcp_demo_echo", makeTool()]]),
	...overrides,
});

const makeToolCall = (): McpDynamicToolCall => ({
	dynamic: true,
	input: { text: "hello" },
	toolCallId: "call_1",
	toolName: "mcp_demo_echo",
});

const EMPTY_STATUSES: readonly McpServerStatus[] = [];

const makeRegistry = (execute?: McpRegistry["execute"]): McpRegistry => ({
	close: async () => undefined,
	createSnapshot: async (mode: ModeType) =>
		makeSnapshot({ id: "snap-latest", mode }),
	execute: execute ?? (async () => successResult()),
	getStatuses: () => EMPTY_STATUSES,
	reconnect: async () => undefined,
	subscribe: () => () => undefined,
});

const makeAddToolOutput = (): {
	addToolOutput: McpAddToolOutput;
	outputs: McpToolOutputConfig[];
} => {
	const outputs: McpToolOutputConfig[] = [];
	const addToolOutput: McpAddToolOutput = (config) => {
		outputs.push(config);
	};
	return { addToolOutput, outputs };
};

const renderProvider = async (registry: McpRegistry) => {
	// Mutable holder so context updates from later renders are visible to the
	// test through the same reference (returning the value directly would freeze
	// the first-render context object).
	const captured: { value: McpContextValue | undefined } = { value: undefined };
	function Consumer() {
		captured.value = useMcp();
		return <text>consumer</text>;
	}
	const setup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<DialogProvider>
					<McpProvider createRegistry={() => registry} workspace="/tmp">
						<Consumer />
					</McpProvider>
				</DialogProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height: 40, width: 120 }
	);
	await setup.renderOnce();
	return { captured, setup };
};

// React schedules passive effects and external-store updates on the scheduler,
// and OpenTUI's stdin parser resolves keys asynchronously. A single renderOnce
// is not enough; yield a macrotask first so scheduled work commits, then draw.
const flushUi = async (
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await setup.renderOnce();
};

test("approval controller resolves true when allowed", async () => {
	const controller = createMcpApprovalController();
	const promise = controller.request(makeRequest());
	controller.allow();
	await expect(promise).resolves.toBe(true);
});

test("approval controller resolves false when denied", async () => {
	const controller = createMcpApprovalController();
	const promise = controller.request(makeRequest());
	controller.deny();
	await expect(promise).resolves.toBe(false);
});

test("approval controller resolves false when cancelled", async () => {
	const controller = createMcpApprovalController();
	const promise = controller.request(makeRequest());
	controller.cancel();
	await expect(promise).resolves.toBe(false);
});

test("approval controller supports multiple concurrent requests", async () => {
	const controller = createMcpApprovalController();
	const first = controller.request(makeRequest());
	const second = controller.request(makeRequest());
	// allow/deny settle the most recent pending request first (dialog stack order).
	controller.allow();
	await expect(second).resolves.toBe(true);
	controller.deny();
	await expect(first).resolves.toBe(false);
});

test("approval controller cancel resolves all pending requests false", async () => {
	const controller = createMcpApprovalController();
	const first = controller.request(makeRequest());
	const second = controller.request(makeRequest());
	controller.cancel();
	await expect(first).resolves.toBe(false);
	await expect(second).resolves.toBe(false);
});

test("approval controller resolves only once per request", async () => {
	const controller = createMcpApprovalController();
	const promise = controller.request(makeRequest());
	controller.allow();
	controller.deny();
	await expect(promise).resolves.toBe(true);
});

test("runDynamicToolCall emits no-active-catalog error for null snapshot", async () => {
	const { addToolOutput, outputs } = makeAddToolOutput();
	await runDynamicToolCall({
		addToolOutput,
		latestSnapshot: makeSnapshot(),
		openApproval: () => undefined,
		registry: makeRegistry(),
		snapshot: null,
		toolCall: makeToolCall(),
	});
	expect(outputs).toEqual([
		{
			errorText: "MCP tool call has no active catalog",
			state: "output-error",
			tool: "mcp_demo_echo",
			toolCallId: "call_1",
		},
	]);
});

test("runDynamicToolCall emits no-active-catalog error for stale snapshot", async () => {
	const { addToolOutput, outputs } = makeAddToolOutput();
	await runDynamicToolCall({
		addToolOutput,
		latestSnapshot: makeSnapshot({ id: "snap-newest" }),
		openApproval: () => undefined,
		registry: makeRegistry(),
		snapshot: makeSnapshot({ id: "snap-old" }),
		toolCall: makeToolCall(),
	});
	expect(outputs[0]?.errorText).toBe("MCP tool call has no active catalog");
});

test("runDynamicToolCall denies without executing", async () => {
	let executed = false;
	const { addToolOutput, outputs } = makeAddToolOutput();
	await runDynamicToolCall({
		addToolOutput,
		latestSnapshot: makeSnapshot(),
		openApproval: () => undefined,
		registry: makeRegistry(async () => {
			executed = true;
			return successResult();
		}),
		snapshot: makeSnapshot({
			tools: new Map([["mcp_demo_echo", makeTool({ policy: "deny" })]]),
		}),
		toolCall: makeToolCall(),
	});
	expect(executed).toBe(false);
	expect(outputs).toEqual([
		{
			errorText: "MCP tool 'mcp_demo_echo' is denied by policy",
			state: "output-error",
			tool: "mcp_demo_echo",
			toolCallId: "call_1",
		},
	]);
});

test("runDynamicToolCall executes ask tool after approval", async () => {
	let capturedController: McpApprovalController | undefined;
	let capturedRequest: McpApprovalRequest | undefined;
	const openApproval = (
		request: McpApprovalRequest,
		controller: McpApprovalController
	) => {
		capturedRequest = request;
		capturedController = controller;
	};
	const { addToolOutput, outputs } = makeAddToolOutput();
	const promise = runDynamicToolCall({
		addToolOutput,
		latestSnapshot: makeSnapshot(),
		openApproval,
		registry: makeRegistry(async (_snapshot, _toolName, _input, approve) => {
			await expect(approve(makeRequest())).resolves.toBe(true);
			return successResult();
		}),
		snapshot: makeSnapshot({
			tools: new Map([["mcp_demo_echo", makeTool({ policy: "ask" })]]),
		}),
		toolCall: makeToolCall(),
	});
	expect(capturedRequest).toMatchObject({
		serverName: "demo",
		originalToolName: "echo",
	});
	expect(capturedController).toBeDefined();
	capturedController?.allow();
	await promise;
	expect(outputs).toEqual([
		{
			output: successResult(),
			state: "output-available",
			tool: "mcp_demo_echo",
			toolCallId: "call_1",
		},
	]);
});

test("runDynamicToolCall rejects ask tool after denial without executing", async () => {
	let executed = false;
	let capturedController: McpApprovalController | undefined;
	const { addToolOutput, outputs } = makeAddToolOutput();
	const promise = runDynamicToolCall({
		addToolOutput,
		latestSnapshot: makeSnapshot(),
		openApproval: (_request, controller) => {
			capturedController = controller;
		},
		registry: makeRegistry(async () => {
			executed = true;
			return successResult();
		}),
		snapshot: makeSnapshot({
			tools: new Map([["mcp_demo_echo", makeTool({ policy: "ask" })]]),
		}),
		toolCall: makeToolCall(),
	});
	capturedController?.deny();
	await promise;
	expect(executed).toBe(false);
	expect(outputs).toEqual([
		{
			errorText: "MCP tool 'mcp_demo_echo' was not approved",
			state: "output-error",
			tool: "mcp_demo_echo",
			toolCallId: "call_1",
		},
	]);
});

test("runDynamicToolCall executes allow tool via registry", async () => {
	const { addToolOutput, outputs } = makeAddToolOutput();
	await runDynamicToolCall({
		addToolOutput,
		latestSnapshot: makeSnapshot(),
		openApproval: () => undefined,
		registry: makeRegistry(async (snapshot, toolName, input) => {
			expect(snapshot).toBeDefined();
			expect(toolName).toBe("mcp_demo_echo");
			expect(input).toEqual({ text: "hello" });
			return successResult();
		}),
		snapshot: makeSnapshot(),
		toolCall: makeToolCall(),
	});
	expect(outputs).toEqual([
		{
			output: successResult(),
			state: "output-available",
			tool: "mcp_demo_echo",
			toolCallId: "call_1",
		},
	]);
});

test("runDynamicToolCall sanitizes thrown errors to a stable message", async () => {
	const { addToolOutput, outputs } = makeAddToolOutput();
	await runDynamicToolCall({
		addToolOutput,
		latestSnapshot: makeSnapshot(),
		openApproval: () => undefined,
		registry: makeRegistry(async () => {
			throw new Error("connection failed secret-token-abc");
		}),
		snapshot: makeSnapshot(),
		toolCall: makeToolCall(),
	});
	expect(outputs[0]?.state).toBe("output-error");
	expect(outputs[0]?.errorText).toBe("MCP tool call failed");
	expect(outputs[0]?.errorText).not.toContain("secret-token-abc");
});

test("provider exposes statuses, createSnapshot, reconnect, and close", async () => {
	const listeners = new Set<() => void>();
	let statuses: readonly McpServerStatus[] = [
		{ name: "demo", state: "connected", toolCount: 2, transport: "local" },
	];
	const calls: string[] = [];
	const registry: McpRegistry = {
		close: async () => {
			calls.push("close");
		},
		createSnapshot: async (mode: ModeType) => ({
			id: "snap-1",
			manifest: [],
			mode,
			tools: new Map(),
		}),
		execute: async () => successResult(),
		getStatuses: () => statuses,
		reconnect: async (serverName: string) => {
			calls.push(`reconnect:${serverName}`);
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	const { captured, setup } = await renderProvider(registry);
	expect(captured).toBeDefined();

	expect(captured.value?.statuses).toEqual(statuses);

	await expect(captured.value?.createSnapshot("build")).resolves.toEqual({
		id: "snap-1",
		manifest: [],
		mode: "build",
		tools: new Map(),
	});

	await captured.value?.reconnect("demo");
	expect(calls).toContain("reconnect:demo");

	statuses = [
		...statuses,
		{ name: "demo2", state: "failed", toolCount: 0, transport: "remote" },
	];
	await act(async () => {
		for (const listener of [...listeners]) {
			listener();
		}
	});
	// The store listener forces a re-render and the cached snapshot is rebuilt
	// on the next flush; allow the scheduler to commit before drawing.
	await flushUi(setup);
	expect(captured.value?.statuses.length).toBe(2);

	await captured.value?.close();
	expect(calls.filter((call) => call === "close")).toHaveLength(1);

	setup.renderer.destroy();
	// The unmount cleanup is a passive effect; yield once so it commits before
	// asserting the registry was closed on unmount.
	await flushUi(setup);
	expect(calls.filter((call) => call === "close")).toHaveLength(2);
});

test("provider handleDynamicToolCall opens approval dialog and allow executes", async () => {
	const askRegistry = makeRegistry(async () => successResult());
	const { captured, setup } = await renderProvider(askRegistry);
	const outputs: McpToolOutputConfig[] = [];
	const snapshot = await captured.value?.createSnapshot("build");
	if (snapshot === undefined) {
		throw new Error("expected a snapshot from the mock registry");
	}

	captured.value?.handleDynamicToolCall(
		{
			...snapshot,
			tools: new Map([["mcp_demo_echo", makeTool({ policy: "ask" })]]),
		},
		makeToolCall(),
		(config) => {
			outputs.push(config);
		}
	);
	// Wait for React passive effects (useKeyboard registration) and the
	// async stdin parser, then draw the dialog.
	await flushUi(setup);
	expect(setup.captureCharFrame()).toContain("Allow once");

	setup.mockInput.pressEnter();
	await flushUi(setup);

	expect(outputs).toEqual([
		{
			output: successResult(),
			state: "output-available",
			tool: "mcp_demo_echo",
			toolCallId: "call_1",
		},
	]);
	setup.renderer.destroy();
});

test("provider handleDynamicToolCall rejects on escape", async () => {
	const askRegistry = makeRegistry(async () => successResult());
	const { captured, setup } = await renderProvider(askRegistry);
	const outputs: McpToolOutputConfig[] = [];
	const snapshot = await captured.value?.createSnapshot("build");
	if (snapshot === undefined) {
		throw new Error("expected a snapshot from the mock registry");
	}

	captured.value?.handleDynamicToolCall(
		{
			...snapshot,
			tools: new Map([["mcp_demo_echo", makeTool({ policy: "ask" })]]),
		},
		makeToolCall(),
		(config) => {
			outputs.push(config);
		}
	);
	await flushUi(setup);
	expect(setup.captureCharFrame()).toContain("Deny");

	setup.mockInput.pressEscape();
	// Escape closes the dialog; the unmount cleanup settles the pending request.
	// Allow the unmount and the follow-up store commit before asserting.
	await flushUi(setup);
	await flushUi(setup);

	expect(outputs).toEqual([
		{
			errorText: "MCP tool 'mcp_demo_echo' was not approved",
			state: "output-error",
			tool: "mcp_demo_echo",
			toolCallId: "call_1",
		},
	]);
	setup.renderer.destroy();
});
