// Runnable MCP stdio server used by the MCP transport tests.
// Run directly: `bun run packages/tui/test/support/mcp-stdio-server.ts`.
// stdout carries MCP protocol frames only; all diagnostics go to stderr.
// This file is an entrypoint and intentionally imports nothing from the rest
// of the MCP module so the transport wiring stays self-contained.
import { writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const exitMarker = process.env.WINCODE_MCP_EXIT_MARKER;
if (exitMarker !== undefined) {
	let markerWritten = false;
	const markExited = (): void => {
		if (markerWritten) {
			return;
		}
		markerWritten = true;
		writeFileSync(exitMarker, "exited");
	};
	process.once("exit", markExited);
	process.once("SIGTERM", () => {
		markExited();
		process.exit(0);
	});
}
const writeStderr = (message: string): void => {
	process.stderr.write(`[stdio-server-support] ${message}\n`);
};

const createServer = (): McpServer => {
	const server = new McpServer({ name: "stdio-echo", version: "0.1.0" });
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

void serveStdio(createServer);

writeStderr("stdio echo server listening for MCP clients");
