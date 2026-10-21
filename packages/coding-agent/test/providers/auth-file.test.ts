import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMcpSecretStore } from "@/modules/mcp/mcp-secret-store";
import { createProviderSdkCredentialStore } from "@/modules/providers/provider-stores";

test("Provider credentials do not import legacy Keychain-index files", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-auth-legacy-"));
	try {
		await Bun.write(
			path.join(root, "provider-sdk-credentials.json"),
			JSON.stringify({
				openai: JSON.stringify({ kind: "api-key", apiKey: "old" }),
			})
		);
		expect(
			await createProviderSdkCredentialStore({ userDataDir: root }).read(
				"openai"
			)
		).toBeUndefined();
		expect(
			await createProviderSdkCredentialStore({ userDataDir: root }).list()
		).toEqual([]);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("the former unified auth document does not import MCP secrets and Provider writes discard its old Plugin values", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-auth-split-"));
	try {
		await fs.writeFile(
			path.join(root, "auth.json"),
			JSON.stringify({
				providers: { openai: { kind: "api-key", apiKey: "provider-key" } },
				plugins: {
					mcp: { "oauth.tokens": "old-mcp" },
					first_plugin: { "oauth.tokens": "old-plugin" },
				},
			}),
			{ mode: 0o600 }
		);
		expect(
			await createProviderSdkCredentialStore({ userDataDir: root }).read(
				"openai"
			)
		).toMatchObject({ apiKey: "provider-key" });
		expect(
			await createMcpSecretStore(root).get("oauth.tokens")
		).toBeUndefined();
		await createProviderSdkCredentialStore({ userDataDir: root }).modify(
			"openai",
			() => ({ kind: "api-key", apiKey: "new-provider-key" })
		);
		const authDocument = JSON.stringify(
			await Bun.file(path.join(root, "auth.json")).json()
		);
		expect(authDocument).not.toContain("old-mcp");
		expect(authDocument).not.toContain("old-plugin");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("malformed auth JSON fails closed without overwriting stored data", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-auth-invalid-")
	);
	const authPath = path.join(root, "auth.json");
	try {
		await fs.writeFile(authPath, "{broken", { mode: 0o600 });
		await expect(
			createProviderSdkCredentialStore({ userDataDir: root }).modify(
				"openai",
				() => ({ kind: "api-key" })
			)
		).rejects.toThrow();
		expect(await Bun.file(authPath).text()).toBe("{broken");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("a symlinked auth directory cannot read another user's auth file", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-auth-read-symlink-")
	);
	const target = path.join(root, "target");
	const link = path.join(root, "link");
	try {
		await createProviderSdkCredentialStore({ userDataDir: target }).modify(
			"openai",
			() => ({ kind: "api-key", apiKey: "hidden" })
		);
		await fs.symlink(target, link, "dir");
		await expect(
			createProviderSdkCredentialStore({ userDataDir: link }).read("openai")
		).rejects.toThrow("Refusing insecure auth directory");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("Provider and MCP credentials survive restart in separate private files", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-auth-file-"));
	const userDataDir = path.join(root, "user");
	try {
		const providers = createProviderSdkCredentialStore({ userDataDir });
		const mcp = createMcpSecretStore(userDataDir);
		await providers.modify("openai", () => ({
			kind: "api-key",
			apiKey: "test-key",
		}));
		await mcp.set("oauth.tokens", "mcp-token");
		expect(
			await createProviderSdkCredentialStore({ userDataDir }).list()
		).toEqual([{ providerId: "openai", type: "api-key" }]);
		expect(await createMcpSecretStore(userDataDir).get("oauth.tokens")).toBe(
			"mcp-token"
		);
		const authPath = path.join(userDataDir, "auth.json");
		const mcpPath = path.join(userDataDir, "mcp-auth.json");
		for (const file of [authPath, mcpPath]) {
			expect((await fs.stat(file)).mode % 0o100).toBe(0);
		}
		expect(JSON.stringify(await Bun.file(authPath).json())).not.toContain(
			"mcp-token"
		);
		expect((await fs.stat(userDataDir)).mode % 0o100).toBe(0);
		expect(
			await Bun.file(
				path.join(userDataDir, "provider-sdk-credentials.json")
			).exists()
		).toBe(false);
		expect(
			await Bun.file(
				path.join(userDataDir, "provider-sdk-credential-index.json")
			).exists()
		).toBe(false);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
