// Runnable MCP stdio server fixture used by mcp.integration.test.ts.
// Run directly: `bun run apps/cli/src/modules/mcp/fixtures/stdio-server.ts`.
// stdout carries MCP protocol frames only; all diagnostics go to stderr.
// This file is an entrypoint and intentionally imports nothing from the rest
// of the mcp module so the transport wiring stays self-contained.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const writeStderr = (message: string): void => {
	process.stderr.write(`[stdio-server-fixture] ${message}\n`);
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
