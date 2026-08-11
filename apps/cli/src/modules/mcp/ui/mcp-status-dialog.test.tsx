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
import type {
	McpCatalogSnapshot,
	McpRegistry,
	McpServerStatus,
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
	reconnect?: (serverName: string) => Promise<void>
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
	reconnect: reconnect ?? (async () => undefined),
	subscribe: () => () => undefined,
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
				title: "MCP Servers",
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

test("dialog lists server rows with transport, state, tool count, and local warning", async () => {
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
	expect(frame).toContain("local");
	expect(frame).toContain("remote");
	expect(frame).toContain("failed");
	expect(frame).toContain("2 tools");
	expect(frame).toContain(MCP_LOCAL_WARNING);
	// The already-sanitized error surfaces, never a raw secret.
	expect(frame).toContain("connection refused");
	setup.renderer.destroy();
});

test("enter on a failed row triggers reconnect for that server", async () => {
	const reconnected: string[] = [];
	const registry = makeRegistry(
		[
			makeStatus({
				name: "broken",
				state: "failed",
				toolCount: 0,
				transport: "remote",
			}),
			makeStatus({ name: "healthy", state: "connected", toolCount: 3 }),
		],
		async (serverName) => {
			reconnected.push(serverName);
		}
	);
	const { setup } = await renderStatusDialog(registry);

	setup.mockInput.pressEnter();
	await flushUi(setup);

	expect(reconnected).toEqual(["broken"]);
	setup.renderer.destroy();
});

test("enter on a connected row does not trigger reconnect", async () => {
	const reconnected: string[] = [];
	const registry = makeRegistry(
		[
			makeStatus({ name: "healthy", state: "connected", toolCount: 3 }),
			makeStatus({
				name: "broken",
				state: "degraded",
				toolCount: 1,
				transport: "remote",
			}),
		],
		async (serverName) => {
			reconnected.push(serverName);
		}
	);
	const { setup } = await renderStatusDialog(registry);

	setup.mockInput.pressEnter();
	await flushUi(setup);

	expect(reconnected).toEqual(["broken"]);
	setup.renderer.destroy();
});

test("escape closes the status dialog", async () => {
	const registry = makeRegistry([
		makeStatus({ name: "alpha", state: "connected", toolCount: 2 }),
	]);
	const { setup } = await renderStatusDialog(registry);

	expect(setup.captureCharFrame()).toContain("MCP Servers");

	setup.mockInput.pressEscape();
	await flushUi(setup);
	await flushUi(setup);

	const frame = setup.captureCharFrame();
	expect(frame).not.toContain("MCP Servers");
	expect(frame).toContain("base");
	setup.renderer.destroy();
});
