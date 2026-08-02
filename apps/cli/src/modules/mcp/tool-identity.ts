const MAX_NAME_LENGTH = 64;
const sanitize = (value: string): string =>
	value.normalize("NFKD").replace(/[^a-zA-Z0-9_-]/g, "_");

export async function mcpToolIdentity(
	server: string,
	tool: string
): Promise<string> {
	const bytes = new TextEncoder().encode(`${server}\0${tool}`);
	const digest = Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
	)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 8);
	const serverPart = sanitize(server);
	const toolPart = sanitize(tool);
	const available = MAX_NAME_LENGTH - 9;
	const serverLength = Math.min(serverPart.length, Math.ceil(available / 2));
	const toolLength = Math.min(toolPart.length, available - serverLength);
	return `mcp_${serverPart.slice(0, serverLength)}_${toolPart.slice(0, toolLength)}_${digest}`;
}

export const qualifyMcpToolName = mcpToolIdentity;

export const createMcpToolIdentity = mcpToolIdentity;
