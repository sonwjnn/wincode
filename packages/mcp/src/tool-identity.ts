const MAX_NAME_LENGTH = 64;
const sanitize = (value: string): string =>
	value.normalize("NFKD").replace(/[^a-zA-Z0-9_-]/g, "_");

/**
 * The stable logical Permission action name for an MCP tool:
 * `<sanitizedServer>_<sanitizedTool>`. Unlike {@link qualifyMcpToolName}, this
 * carries no collision-resistant hash and no length bound — it is the name
 * Agent Permission Rules target, never a runtime dispatch identifier. Two tools
 * that sanitize to the same logical name share one Permission rule by design;
 * their distinct hashed identities keep dispatch unambiguous.
 */
export const logicalMcpToolName = (server: string, tool: string): string =>
	`${sanitize(server)}_${sanitize(tool)}`;

export async function qualifyMcpToolName(
	server: string,
	tool: string
): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify([server, tool]));
	const digest = Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
	)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 8);
	const serverPart = sanitize(server);
	const toolPart = sanitize(tool);
	const available =
		MAX_NAME_LENGTH - "mcp_".length - 2 - "_".length - digest.length;
	const serverLength = Math.min(serverPart.length, Math.ceil(available / 2));
	const toolLength = Math.min(toolPart.length, available - serverLength);
	return `mcp_${serverPart.slice(0, serverLength)}_${toolPart.slice(0, toolLength)}_${digest}`;
}
