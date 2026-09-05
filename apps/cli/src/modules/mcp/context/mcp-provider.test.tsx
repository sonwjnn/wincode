import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { AgentId } from "@wincode/agent-core";
import { act, useState } from "react";
import { DialogProvider } from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import type {
	McpCatalogSnapshot,
	McpRegistry,
	McpServerStatus,
} from "../registry";
import type { McpNormalizedResult } from "../result";
import { McpActiveIndicator } from "../ui/mcp-active-indicator";
import type { McpContextValue } from "./mcp-provider";
import { buildMcpSummary, McpProvider, useMcp } from "./mcp-provider";

const successResult = (): McpNormalizedResult => ({
	content: [{ type: "text", text: "ok" }],
	isError: false,
	truncated: false,
});

const EMPTY_STATUSES: readonly McpServerStatus[] = [];

const makeRegistry = (execute?: McpRegistry["execute"]): McpRegistry => ({
	close: async () => undefined,
	createSnapshot: async (agent: AgentId): Promise<McpCatalogSnapshot> => ({
		agent,
		id: "snap-1",
		manifest: [],
		tools: new Map(),
	}),
	execute: execute ?? (async () => successResult()),
	getStatuses: () => EMPTY_STATUSES,
	initialize: async () => undefined,
	reconnect: async () => undefined,
	subscribe: () => () => undefined,
	toggle: async () => undefined,
});

const renderProvider = async (registry: McpRegistry) => {
	const captured: { value: McpContextValue | undefined } = { value: undefined };
	function Consumer() {
		captured.value = useMcp();
		return <text>consumer</text>;
	}
	const setup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<ToastProvider>
					<DialogProvider>
						<McpProvider createRegistry={() => registry} workspace="/tmp">
							<Consumer />
						</McpProvider>
					</DialogProvider>
				</ToastProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height: 40, width: 120 }
	);
	await setup.renderOnce();
	return { captured, setup };
};

const flushUi = async (
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await setup.renderOnce();
};

test("provider exposes statuses, snapshots, runtime controls, and close", async () => {
	const listeners = new Set<() => void>();
	let statuses: readonly McpServerStatus[] = [
		{ name: "demo", state: "connected", toolCount: 2, transport: "local" },
	];
	const calls: string[] = [];
	const registry: McpRegistry = {
		close: async () => {
			calls.push("close");
		},
		createSnapshot: async (agent: AgentId) => ({
			id: "snap-1",
			manifest: [],
			agent,
			tools: new Map(),
		}),
		execute: async () => successResult(),
		getStatuses: () => statuses,
		initialize: async () => {
			calls.push("initialize");
		},
		reconnect: async (serverName: string) => {
			calls.push(`reconnect:${serverName}`);
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		toggle: async (serverName: string) => {
			calls.push(`toggle:${serverName}`);
		},
	};
	const { captured, setup } = await renderProvider(registry);
	expect(captured).toBeDefined();

	expect(captured.value?.statuses).toEqual(statuses);
	await flushUi(setup);
	expect(calls.filter((call) => call === "initialize")).toHaveLength(1);
	await captured.value?.initialize();
	expect(calls.filter((call) => call === "initialize")).toHaveLength(2);

	await expect(captured.value?.createSnapshot("build")).resolves.toEqual({
		agent: "build",
		id: "snap-1",
		manifest: [],
		tools: new Map(),
	});

	await captured.value?.reconnect("demo");
	expect(calls).toContain("reconnect:demo");
	await captured.value?.toggle("demo");
	expect(calls).toContain("toggle:demo");

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

test("provider does not close an externally owned registry on unmount", async () => {
	let closeCalls = 0;
	const registry: McpRegistry = {
		...makeRegistry(),
		close: async () => {
			closeCalls += 1;
		},
	};
	const setup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<ToastProvider>
					<DialogProvider>
						<McpProvider
							closeRegistryOnUnmount={false}
							createRegistry={() => registry}
							workspace="/tmp"
						>
							<text>consumer</text>
						</McpProvider>
					</DialogProvider>
				</ToastProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height: 10, width: 40 }
	);
	await setup.renderOnce();
	setup.renderer.destroy();
	await flushUi(setup);

	expect(closeCalls).toBe(0);
});

test("MCP failure summary identifies every failed server and reason", () => {
	expect(
		buildMcpSummary([
			{
				error: "Invalid MCP server configuration",
				name: "websearch",
				state: "failed",
				toolCount: 0,
				transport: "remote",
			},
			{
				name: "context7",
				state: "failed",
				toolCount: 0,
				transport: "local",
			},
		])
	).toBe(
		"MCP failed:\nwebsearch: Invalid MCP server configuration\ncontext7: Connection failed"
	);
});

test("provider shows a single summary toast after the first build snapshot", async () => {
	let statuses: readonly McpServerStatus[] = [
		{ name: "demo", state: "connected", toolCount: 2, transport: "local" },
		{
			error: "Connection refused",
			name: "broken",
			state: "failed",
			toolCount: 0,
			transport: "remote",
		},
	];
	const registry: McpRegistry = {
		...makeRegistry(),
		getStatuses: () => statuses,
	};
	const { captured, setup } = await renderProvider(registry);

	await captured.value?.createSnapshot("build");
	await flushUi(setup);
	expect(setup.captureCharFrame()).toContain("broken: Connection refused");

	// A later snapshot with different server counts must not emit a second
	// summary toast; the first-init flag holds.
	statuses = [
		{ name: "demo", state: "connected", toolCount: 2, transport: "local" },
		{
			error: "Connection refused",
			name: "broken",
			state: "failed",
			toolCount: 0,
			transport: "remote",
		},
		{ name: "broken2", state: "failed", toolCount: 0, transport: "remote" },
	];
	await captured.value?.createSnapshot("build");
	await flushUi(setup);

	const frame = setup.captureCharFrame();
	expect(frame).not.toContain("broken2");
	expect(frame).toContain("broken: Connection refused");
	setup.renderer.destroy();
});

test("provider refreshes without closing the registry when the route changes", async () => {
	let setRoute: ((route: string) => void) | undefined;
	let initializeCount = 0;
	let closeCount = 0;
	let statuses: readonly McpServerStatus[] = [
		{ name: "demo", state: "connected", toolCount: 1, transport: "local" },
	];
	const registry: McpRegistry = {
		...makeRegistry(),
		close: async () => {
			closeCount += 1;
		},
		initialize: async () => {
			initializeCount += 1;
		},
		getStatuses: () => statuses,
	};
	function Harness() {
		const [route, updateRoute] = useState("/sessions/one");
		setRoute = updateRoute;
		return (
			<McpProvider
				createRegistry={() => registry}
				refreshKey={route}
				workspace="/tmp"
			>
				<text>consumer</text>
			</McpProvider>
		);
	}
	const setup = await testRender(
		<ThemeProvider>
			<ToastProvider>
				<Harness />
			</ToastProvider>
		</ThemeProvider>,
		{ height: 40, width: 120 }
	);
	await flushUi(setup);
	expect(initializeCount).toBe(1);
	statuses = [
		{
			error: "Invalid MCP server configuration",
			name: "demo",
			state: "failed",
			toolCount: 0,
			transport: "local",
		},
	];

	await act(async () => {
		setRoute?.("/sessions/two");
	});
	await flushUi(setup);

	expect(initializeCount).toBe(2);
	expect(closeCount).toBe(0);
	expect(setup.captureCharFrame()).toContain(
		"demo: Invalid MCP server configuration"
	);
	setup.renderer.destroy();
});

test("provider exposes loading state through the MCP active indicator", async () => {
	let finishInitialize: (() => void) | undefined;
	const pendingInitialize = new Promise<void>((resolve) => {
		finishInitialize = resolve;
	});
	const registry: McpRegistry = {
		...makeRegistry(),
		getStatuses: () => [
			{ name: "demo", state: "connected", toolCount: 1, transport: "local" },
			{
				name: "websearch",
				state: "connected",
				toolCount: 1,
				transport: "remote",
			},
		],
		initialize: () => pendingInitialize,
	};
	const setup = await testRender(
		<ThemeProvider>
			<ToastProvider>
				<McpProvider createRegistry={() => registry} workspace="/tmp">
					<McpActiveIndicator />
				</McpProvider>
			</ToastProvider>
		</ThemeProvider>,
		{ height: 40, width: 120 }
	);
	await flushUi(setup);
	expect(setup.captureCharFrame()).toContain("Loading...");

	finishInitialize?.();
	await flushUi(setup);

	expect(setup.captureCharFrame()).toContain("2 MCPs");
	setup.renderer.destroy();
});

test("provider keeps loading state active during reconnect and toggle", async () => {
	let finishReconnect: (() => void) | undefined;
	let finishToggle: (() => void) | undefined;
	const pendingReconnect = new Promise<void>((resolve) => {
		finishReconnect = resolve;
	});
	const pendingToggle = new Promise<void>((resolve) => {
		finishToggle = resolve;
	});
	const registry: McpRegistry = {
		...makeRegistry(),
		reconnect: () => pendingReconnect,
		toggle: () => pendingToggle,
	};
	const { captured, setup } = await renderProvider(registry);
	await flushUi(setup);

	const reconnect = captured.value?.reconnect("demo");
	await flushUi(setup);
	expect(captured.value?.isLoading).toBe(true);
	finishReconnect?.();
	await reconnect;
	await flushUi(setup);
	expect(captured.value?.isLoading).toBe(false);

	const toggle = captured.value?.toggle("demo");
	await flushUi(setup);
	expect(captured.value?.isLoading).toBe(true);
	finishToggle?.();
	await toggle;
	await flushUi(setup);
	expect(captured.value?.isLoading).toBe(false);
	setup.renderer.destroy();
});

test("provider shows no summary toast when all MCP servers connect", async () => {
	const registry: McpRegistry = {
		...makeRegistry(),
		getStatuses: () => [
			{ name: "demo", state: "connected", toolCount: 2, transport: "local" },
		],
	};
	const { captured, setup } = await renderProvider(registry);

	await captured.value?.createSnapshot("build");
	await flushUi(setup);
	expect(setup.captureCharFrame()).not.toContain("MCP:");

	// A plan snapshot never summarizes either.
	await captured.value?.createSnapshot("plan");
	await flushUi(setup);
	expect(setup.captureCharFrame()).not.toContain("MCP:");
	setup.renderer.destroy();
});

test("provider shows a toast when reconnect leaves an MCP failed", async () => {
	const registry: McpRegistry = {
		...makeRegistry(),
		getStatuses: () => [
			{
				error: "URL must be absolute http or https URL",
				name: "websearch",
				state: "failed",
				toolCount: 0,
				transport: "remote",
			},
		],
	};
	const { captured, setup } = await renderProvider(registry);

	await captured.value?.reconnect("websearch");
	await flushUi(setup);

	expect(setup.captureCharFrame()).toContain(
		"websearch: URL must be absolute http or https URL"
	);
	setup.renderer.destroy();
});
