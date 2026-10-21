import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMcpOAuthProvider } from "@wincode/mcp";
import { createMcpSecretStore } from "@/modules/mcp/mcp-secret-store";

test("MCP OAuth credentials fit the secret-key limit for issuer and server names", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-mcp-oauth-secrets-")
	);
	try {
		const secrets = createMcpSecretStore(root);
		const cases = [
			{ serverName: "calendar", issuer: "https://auth.example.test" },
			{
				serverName: `long-${"server-".repeat(20)}`,
				issuer: `https://auth.example.test/${"realm/".repeat(30)}`,
			},
		];
		for (const [index, { issuer, serverName }] of cases.entries()) {
			const provider = createMcpOAuthProvider({ secrets, serverName });
			const tokens = {
				access_token: `access-${index}`,
				issuer,
				token_type: "Bearer",
			};
			await provider.saveTokens(tokens, { issuer });
			expect(await provider.tokens({ issuer })).toEqual(tokens);
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
