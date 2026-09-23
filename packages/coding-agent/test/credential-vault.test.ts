import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialVaultV2 } from "../modules/connections/v2-credential-vault";

/** The shape a headless Linux host reports: a secret backend that cannot serve. */
const unusableSecretStore = {
	get: async (): Promise<string | null> => {
		throw new Error("libsecret not available");
	},
	set: async (): Promise<void> => {
		throw new Error("libsecret not available");
	},
};

test("an unusable OS secret backend falls back to the vault's file store", async () => {
	const root = await mkdtemp(join(tmpdir(), "wincode-credential-vault-"));
	try {
		const vault = new CredentialVaultV2({
			fileRoot: root,
			secretStore: unusableSecretStore,
		});

		expect(await vault.load("anthropic")).toBeNull();
		await vault.replaceValidated("anthropic", {
			apiKey: "sk-ant-test",
			kind: "api-key",
		});
		expect(await vault.load("anthropic")).toEqual({
			apiKey: "sk-ant-test",
			kind: "api-key",
		});
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});
