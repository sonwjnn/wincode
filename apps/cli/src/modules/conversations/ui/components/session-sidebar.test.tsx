import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { McpServerStatus } from "@/modules/mcp";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { McpSidebarSection } from "./session-sidebar";

const statuses = [
	{ name: "context7", state: "connected", toolCount: 2, transport: "remote" },
	{ name: "figma-mcp-go", state: "disabled", toolCount: 0, transport: "local" },
	{ name: "degraded", state: "degraded", toolCount: 1, transport: "remote" },
	{
		name: "websearch-with-an-extremely-long-server-name",
		state: "connected",
		toolCount: 1,
		transport: "remote",
	},
] satisfies McpServerStatus[];

test("renders MCP statuses and clips long names at narrow widths", async () => {
	const setup = await testRender(
		<ThemeProvider>
			<McpSidebarSection statuses={statuses} />
		</ThemeProvider>,
		{ height: 12, width: 30 }
	);

	try {
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		expect(frame).toContain("● context7");
		expect(frame).toContain("Connected");
		expect(frame).toContain("● figma-mcp-go");
		expect(frame).toContain("Disabled");
		expect(frame).toContain("Degraded");
		expect(frame).not.toContain("websearch-with-an-extremely-long-server-name");
	} finally {
		setup.renderer.destroy();
	}
});

test("renders an empty MCP state", async () => {
	const setup = await testRender(
		<ThemeProvider>
			<McpSidebarSection statuses={[]} />
		</ThemeProvider>,
		{ height: 4, width: 30 }
	);

	try {
		await setup.renderOnce();
		expect(setup.captureCharFrame()).toContain("No MCPs");
	} finally {
		setup.renderer.destroy();
	}
});
