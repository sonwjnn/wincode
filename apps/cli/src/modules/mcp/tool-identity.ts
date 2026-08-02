import { createHash } from "node:crypto";

const MAX_NAME_LENGTH = 64;
const sanitize = (value: string): string =>
	value.normalize("NFKD").replace(/[^a-zA-Z0-9_-]/g, "_");

export async function mcpToolIdentity(
	server: string,
	tool: string
): Promise<string> {
	const digest = createHash("sha256")
		.update(`${server}\0${tool}`, "utf8")
		.digest("hex")
		.slice(0, 8);
	const prefix = `mcp_${sanitize(server)}_${sanitize(tool)}_`;
	return `${prefix.slice(0, MAX_NAME_LENGTH - 8)}${digest}`;
}

export const createMcpToolIdentity = mcpToolIdentity;
