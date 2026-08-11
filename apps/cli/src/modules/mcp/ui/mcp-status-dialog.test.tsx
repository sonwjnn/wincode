import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { AgentId } from "@wincode/ai";
import { useEffect } from "react";
import {
	DialogProvider,
	useDialog,
} from "@/shared/providers/dialog/dialog-provider";
import {
	KeyboardLayerProvider,
	useKeyboardLayer,
} from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import { McpProvider } from "../context/mcp-provider";
import {
	createMcpRegistry,
	type McpCatalogSnapshot,
	type McpRegistry,
	type McpServerStatus,
} from "../registry";
import {
	formatStatusRow,
	MCP_LOCAL_WARNING,
	McpStatusDialogContent,
} from "./mcp-status-dialog";

const makeStatus = (
	overrides: Partial<McpServerStatus> = {}
): McpServerStatus => ({
	name: "demo",
	state: "connected",
	toolCount: 1,
	transport: "local",
	...overrides,
});

const makeRegistry = (
	statuses: readonly McpServerStatus[],
	toggle?: (serverName: string) => Promise<void>
): McpRegistry => ({
	close: async () => undefined,
	createSnapshot: async (agent: AgentId): Promise<McpCatalogSnapshot> => ({
		agent,
		id: "snap-1",
		manifest: [],
		tools: new Map(),
	}),
	execute: async () => ({ content: [], isError: false, truncated: false }),
	getStatuses: () => statuses,
	initialize: async () => undefined,
	reconnect: async () => undefined,
	subscribe: () => () => undefined,
	toggle: toggle ?? (async () => undefined),
});

const flushUi = async (
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await setup.renderOnce();
};

const renderStatusDialog = async (registry: McpRegistry) => {
	// Open the dialog through the provider so escape can close it through the
	// dialog stack, exactly like the app opens it via the command executor.
	function Harness() {
		const { push } = useKeyboardLayer();
		const { open } = useDialog();
		useEffect(() => {
			push("dialog");
			open({
				children: <McpStatusDialogContent />,
				padding: { bottom: 1, left: 0, right: 0, top: 1 },
				title: "MCPs",
				titleMargin: { left: 4, right: 4 },
				width: 118,
			});
		}, [open, push]);
		return <text>base</text>;
	}
	const setup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<ToastProvider>
					{/*
					 * Mirrors root-layout: McpProvider sits inside an outer
					 * DialogProvider (used by the approval flow), while the dialog
					 * under test mounts through an inner DialogProvider so its
					 * useMcp call resolves.
					 */}
					<DialogProvider>
						<McpProvider createRegistry={() => registry} workspace="/tmp">
							<DialogProvider>
								<Harness />
							</DialogProvider>
						</McpProvider>
					</DialogProvider>
				</ToastProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height: 40, width: 120 }
	);
	await setup.renderOnce();
	await flushUi(setup);
	return { setup };
};

test("formatStatusRow carries server, transport, state, and tool count", () => {
	const row = formatStatusRow(
		makeStatus({ name: "demo", state: "connected", toolCount: 3 })
	);
	expect(row.server).toBe("demo");
	expect(row.transport).toBe("local");
	expect(row.state).toBe("connected");
	expect(row.toolCount).toBe(3);
});

test("formatStatusRow includes the OS-permissions warning for local rows", () => {
	const row = formatStatusRow(makeStatus({ name: "demo", transport: "local" }));
	expect(row.warning).toBe(MCP_LOCAL_WARNING);
});

test("formatStatusRow omits the warning for remote rows", () => {
	const row = formatStatusRow(
		makeStatus({ name: "remote", transport: "remote" })
	);
	expect(row.warning).toBeUndefined();
});

test("formatStatusRow marks degraded and failed rows reconnectable", () => {
	expect(formatStatusRow(makeStatus({ state: "degraded" })).reconnectable).toBe(
		true
	);
	expect(formatStatusRow(makeStatus({ state: "failed" })).reconnectable).toBe(
		true
	);
});

test("formatStatusRow marks connected, connecting, and disabled rows non-reconnectable", () => {
	expect(
		formatStatusRow(makeStatus({ state: "connected" })).reconnectable
	).toBe(false);
	expect(
		formatStatusRow(makeStatus({ state: "connecting" })).reconnectable
	).toBe(false);
	expect(formatStatusRow(makeStatus({ state: "disabled" })).reconnectable).toBe(
		false
	);
});

test("formatStatusRow derives runtime enabled state", () => {
	expect(formatStatusRow(makeStatus({ state: "connected" })).enabled).toBe(
		true
	);
	expect(formatStatusRow(makeStatus({ state: "failed" })).enabled).toBe(true);
	expect(formatStatusRow(makeStatus({ state: "disabled" })).enabled).toBe(
		false
	);
});

test("formatStatusRow never exposes config, env, headers, or urls in the error", () => {
	const row = formatStatusRow(
		makeStatus({
			error:
				"connect failed at https://secret-host.example/mcp with token=super-secret-token",
			state: "failed",
		})
	);
	expect(row.error).toBeDefined();
	expect(row.error).not.toContain("secret-host.example");
	expect(row.error).not.toContain("super-secret-token");
});

test("formatStatusRow omits the error when the status has none", () => {
	const row = formatStatusRow(makeStatus({ state: "connected" }));
	expect(row.error).toBeUndefined();
});

test("dialog renders MCP state and runtime enabled status", async () => {
	const registry = makeRegistry([
		makeStatus({ name: "alpha", state: "connected", toolCount: 2 }),
		makeStatus({
			name: "beta",
			state: "failed",
			toolCount: 0,
			transport: "remote",
			error: "connection refused [redacted]",
		}),
	]);
	const { setup } = await renderStatusDialog(registry);

	const frame = setup.captureCharFrame();
	expect(frame).toContain("alpha");
	expect(frame).toContain("beta");
	expect(frame).toContain("connected");
	expect(frame).toContain("failed");
	expect(frame).toContain("Enabled");
	expect(frame).toContain("toggle space");
	const headerLine = frame.split("\n").find((line) => line.includes("esc"));
	const enabledLine = frame.split("\n").find((line) => line.includes("alpha"));
	expect((headerLine?.lastIndexOf("esc") ?? -3) + "esc".length).toBe(
		(enabledLine?.lastIndexOf("Enabled") ?? -7) + "Enabled".length
	);
	setup.renderer.destroy();
});

test("dialog initializes configured servers before a catalog snapshot exists", async () => {
	const registry = createMcpRegistry({
		workspace: "/tmp",
		loadConfig: async () => ({
			diagnostics: [],
			servers: {
				context7: {
					name: "context7",
					type: "local",
					command: ["context7"],
					disabled: false,
					permission: "allow",
					timeout: { startup: 1000, catalog: 1000, execution: 1000 },
				},
			},
		}),
		createClient: () => ({
			callTool: async () => ({ content: [] }),
			close: async () => undefined,
			connect: async () => undefined,
			listTools: async () => [],
			setToolsChangedListener: () => undefined,
		}),
	});
	const { setup } = await renderStatusDialog(registry);

	const frame = setup.captureCharFrame();
	expect(frame).toContain("context7");
	expect(frame).not.toContain("No MCPs");
	setup.renderer.destroy();
});

test("space toggles the highlighted MCP without changing the search input", async () => {
	const toggled: string[] = [];
	let finishToggle: (() => void) | undefined;
	const pendingToggle = new Promise<void>((resolve) => {
		finishToggle = resolve;
	});
	const registry = makeRegistry(
		[
			makeStatus({ name: "healthy", state: "connected", toolCount: 3 }),
			makeStatus({
				name: "off",
				state: "disabled",
				toolCount: 0,
				transport: "remote",
			}),
		],
		async (serverName) => {
			toggled.push(serverName);
			await pendingToggle;
		}
	);
	const { setup } = await renderStatusDialog(registry);
	const initialFrame = setup.captureCharFrame();
	expect(initialFrame).toContain("Disabled");
	expect(initialFrame).toContain("Search");

	await setup.mockInput.typeText(" ");
	await setup.mockInput.typeText(" ");
	await flushUi(setup);
	expect(toggled).toEqual(["healthy"]);
	expect(setup.captureCharFrame()).toContain("Loading...");
	expect(setup.captureCharFrame()).toContain("loading...");
	expect(setup.captureCharFrame()).toContain("Search");

	finishToggle?.();
	await flushUi(setup);

	setup.mockInput.pressArrow("down");
	await flushUi(setup);
	await setup.mockInput.typeText(" ");
	await flushUi(setup);

	expect(toggled).toEqual(["healthy", "off"]);
	setup.renderer.destroy();
});

test("space does not toggle a server hidden by the search filter", async () => {
	const toggled: string[] = [];
	const registry = makeRegistry(
		[makeStatus({ name: "context7" })],
		async (serverName) => {
			toggled.push(serverName);
		}
	);
	const { setup } = await renderStatusDialog(registry);

	await setup.mockInput.typeText("missing");
	await flushUi(setup);
	expect(setup.captureCharFrame()).toContain("No MCPs");

	await setup.mockInput.typeText(" ");
	await flushUi(setup);
	expect(toggled).toEqual([]);
	setup.renderer.destroy();
});

test("escape closes the status dialog", async () => {
	const registry = makeRegistry([
		makeStatus({ name: "alpha", state: "connected", toolCount: 2 }),
	]);
	const { setup } = await renderStatusDialog(registry);

	expect(setup.captureCharFrame()).toContain("MCPs");

	setup.mockInput.pressEscape();
	await flushUi(setup);
	await flushUi(setup);

	const frame = setup.captureCharFrame();
	expect(frame).not.toContain("MCPs");
	expect(frame).toContain("base");
	setup.renderer.destroy();
});
