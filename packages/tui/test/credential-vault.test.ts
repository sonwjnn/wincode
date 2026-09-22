import { expect, test } from "bun:test";
import { CredentialVaultV2 } from "../modules/connections/v2-credential-vault";

test("CredentialVaultV2 falls back when the OS secret backend is unavailable", () => {
	const bunSecrets = {
		get: async () => null,
		set: async () => undefined,
	};
	Object.defineProperty(bunSecrets, "get", {
		configurable: true,
		get: () => {
			throw new Error("libsecret unavailable");
		},
	});

	expect(() => new CredentialVaultV2({ bunSecrets })).not.toThrow();
});
