import * as path from "node:path";
import type { McpSecretStore } from "@wincode/mcp";
import { createPrivateSecretStore } from "@/shared/storage/private-secret-store";

/** MCP OAuth storage belongs to the application, not the protocol package or Plugins. */
export const createMcpSecretStore = (userDataDir: string): McpSecretStore =>
	createPrivateSecretStore(
		userDataDir,
		path.join(userDataDir, "mcp-auth.json"),
		"MCP secret"
	);
