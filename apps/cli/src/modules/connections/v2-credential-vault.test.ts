import { afterEach, describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialVaultV2 } from "./v2-credential-vault";

const paths: string[] = [];
afterEach(async () => {
	for (const path of paths.splice(0)) {
		await rm(path, { force: true, recursive: true });
	}
});

describe("v2 credential vault", () => {
	test("uses v2 account and file path", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-v2-"));
		paths.push(root);
		const vault = new CredentialVaultV2({ fileRoot: root });
		await vault.replaceValidated("openai", {
			apiKey: "sk-test",
			kind: "api-key",
		});
		expect(await vault.load("openai")).toEqual({
			apiKey: "sk-test",
			kind: "api-key",
		});
		const path = join(root, ".wincode", "connections-v2", "openai.json");
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			apiKey: "sk-test",
			kind: "api-key",
		});
		expect(
			(await stat(join(root, ".wincode", "connections-v2"))).mode
				.toString(8)
				.slice(-3)
		).toBe("700");
		expect((await stat(path)).mode.toString(8).slice(-3)).toBe("600");
	});

	test("rejects symlink target", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-v2-"));
		paths.push(root);
		const secureParent = join(root, ".wincode");
		const path = join(root, ".wincode", "connections-v2", "openai.json");
		const target = join(secureParent, "target.json");
		await mkdir(join(secureParent, "connections-v2"), { recursive: true });
		await chmod(secureParent, 0o700);
		await chmod(join(secureParent, "connections-v2"), 0o700);
		await writeFile(target, "{}");
		await symlink(target, path);
		await expect(
			new CredentialVaultV2({ fileRoot: root }).replaceValidated("openai", {
				apiKey: "sk-test",
				kind: "api-key",
			})
		).rejects.toThrow("Refusing to replace non-regular connections file");
	});

	test("rejects insecure symlinked directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-v2-"));
		paths.push(root);
		const realDirectory = join(root, "real");
		const directory = join(root, ".wincode", "connections-v2");
		const filePath = join(directory, "openai.json");
		await mkdir(realDirectory, { recursive: true });
		await chmod(realDirectory, 0o700);
		await mkdir(join(root, ".wincode"), { recursive: true });
		await symlink(realDirectory, directory);
		await expect(
			new CredentialVaultV2({ fileRoot: root }).replaceValidated("openai", {
				apiKey: "sk-test",
				kind: "api-key",
			})
		).rejects.toThrow("Refusing insecure connections directory");
		expect(filePath).toContain("openai.json");
	});

	test("rejects symlinked .wincode without creating child", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-v2-"));
		paths.push(root);
		const realWincode = join(root, "real-wincode");
		const wincodeDirectory = join(root, ".wincode");
		const connectionsDirectory = join(wincodeDirectory, "connections-v2");
		await mkdir(realWincode, { recursive: true });
		await chmod(realWincode, 0o700);
		await symlink(realWincode, wincodeDirectory);

		await expect(
			new CredentialVaultV2({ fileRoot: root }).replaceValidated("openai", {
				apiKey: "sk-test",
				kind: "api-key",
			})
		).rejects.toThrow("Refusing insecure connections directory");
		await expect(stat(connectionsDirectory)).rejects.toThrow();
	});

	test("provider mismatch stays isolated by file path", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-v2-"));
		paths.push(root);
		const vault = new CredentialVaultV2({ fileRoot: root });
		await vault.replaceValidated("anthropic", {
			apiKey: "sk-anthropic",
			kind: "api-key",
		});
		expect(await vault.load("openai")).toBeNull();
		expect(await vault.load("anthropic")).toEqual({
			apiKey: "sk-anthropic",
			kind: "api-key",
		});
	});

	test("rejects insecure ancestor directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-v2-"));
		paths.push(root);
		const directory = join(root, ".wincode", "connections-v2");
		await mkdir(directory, { recursive: true });
		await chmod(directory, 0o755);
		await expect(
			new CredentialVaultV2({ fileRoot: root }).replaceValidated("openai", {
				apiKey: "sk-test",
				kind: "api-key",
			})
		).rejects.toThrow("Refusing insecure connections directory permissions");
	});

	test("sanitizes invalid stored credential errors", async () => {
		const secretStore = {
			get: async () =>
				JSON.stringify({
					kind: "api-key",
					apiKey: "sk-secret",
					extraField: true,
				}),
			set: async () => undefined,
		};
		await expect(
			new CredentialVaultV2({ secretStore }).load("openai")
		).rejects.toThrow(
			"Stored OpenAI connection is invalid. Reconnect with /connect."
		);
		try {
			await new CredentialVaultV2({ secretStore }).load("openai");
		} catch (error) {
			expect(String(error)).not.toContain("sk-secret");
			expect(String(error)).not.toContain("extraField");
		}
	});

	test("stores Bun v2 account namespace per provider", async () => {
		const seen: Array<{ account: string; service: string; value: string }> = [];
		const vault = new CredentialVaultV2({
			secretStore: {
				get: async () => null,
				set: async (service, account, secret) => {
					seen.push({ account, service, value: secret });
				},
			},
		});
		await vault.replaceValidated("openai", {
			apiKey: "sk-test",
			kind: "api-key",
		});
		expect(seen).toEqual([
			{
				account: "connections-v2:openai",
				service: "wincode",
				value: JSON.stringify({ kind: "api-key", apiKey: "sk-test" }),
			},
		]);
	});
});
