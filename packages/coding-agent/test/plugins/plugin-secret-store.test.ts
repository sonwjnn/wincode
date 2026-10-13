import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMcpOAuthProvider } from "@wincode/mcp";
import { createPluginSecretStore } from "@/modules/plugins/plugin-secret-store";

test("Plugin secrets are isolated and use a private local fallback", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-plugin-secrets-")
	);
	try {
		const firstPlugin = createPluginSecretStore("first_plugin", root, null);
		const secondPlugin = createPluginSecretStore("second_plugin", root, null);

		await firstPlugin.set("oauth.tokens", "private-token");
		const restartedFirstPlugin = createPluginSecretStore(
			"first_plugin",
			root,
			null
		);
		expect(await restartedFirstPlugin.get("oauth.tokens")).toBe(
			"private-token"
		);
		expect(await secondPlugin.get("oauth.tokens")).toBeUndefined();

		const directory = path.join(root, "plugin-secrets");
		const filePath = path.join(directory, "first_plugin.json");
		const directoryMode = (await fs.lstat(directory)).mode % 0o100;
		const fileMode = (await fs.lstat(filePath)).mode % 0o100;
		expect(directoryMode).toBe(0);
		expect(fileMode).toBe(0);

		await firstPlugin.delete("oauth.tokens");
		expect(await firstPlugin.get("oauth.tokens")).toBeUndefined();
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("MCP OAuth credentials fit the secret-key limit for issuer and server names", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-mcp-oauth-secrets-")
	);
	try {
		const secrets = createPluginSecretStore("mcp", root, null);
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
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("Plugin secrets use the platform backend with Plugin-qualified accounts", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-plugin-keychain-")
	);
	const values = new Map<string, string>();
	const operations: string[] = [];
	const store = createPluginSecretStore("oauth_plugin", root, {
		delete: async ({ name, service }) => {
			operations.push(`delete:${service}:${name}`);
			return values.delete(`${service}:${name}`);
		},
		get: async ({ name, service }) => {
			operations.push(`get:${service}:${name}`);
			return values.get(`${service}:${name}`) ?? null;
		},
		set: async ({ name, service, value }) => {
			operations.push(`set:${service}:${name}`);
			values.set(`${service}:${name}`, value);
		},
	});
	try {
		await store.set("oauth.tokens", "refresh-token");
		expect(await store.get("oauth.tokens")).toBe("refresh-token");
		await store.delete("oauth.tokens");
		expect(operations).toEqual([
			"set:wincode-plugin:oauth_plugin:oauth.tokens",
			"get:wincode-plugin:oauth_plugin:oauth.tokens",
			"delete:wincode-plugin:oauth_plugin:oauth.tokens",
		]);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});
