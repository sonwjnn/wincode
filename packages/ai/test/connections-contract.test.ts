import { expect, test } from "bun:test";
import {
	type ConnectionsVault,
	type CredentialByProvider,
	createConnections,
	createProviderAdapters,
} from "@wincode/ai/connections";
import type { ConnectionProviderId } from "@wincode/ai/models";

const createMemoryVault = (): ConnectionsVault => {
	const credentials = new Map<ConnectionProviderId, unknown>();
	return {
		async load<P extends ConnectionProviderId>(providerId: P) {
			return (credentials.get(providerId) ?? null) as
				| CredentialByProvider[P]
				| null;
		},
		async replaceValidated<P extends ConnectionProviderId>(
			providerId: P,
			credential: CredentialByProvider[P]
		) {
			credentials.set(providerId, credential);
		},
	};
};

test("connects, validates, and authorizes through the public connections contract", async () => {
	const validatedKeys: string[] = [];
	const connections = createConnections({
		adapters: createProviderAdapters({
			validateAnthropicApiKey: async (apiKey) => {
				validatedKeys.push(apiKey);
				if (apiKey !== "valid-key") {
					throw new Error("Anthropic API key validation failed.");
				}
			},
		}),
		vault: createMemoryVault(),
	});

	const before = await connections.listProviders();
	expect(before.map((provider) => provider.id)).toEqual([
		"anthropic",
		"google",
		"openai",
		"opencode-go",
	]);
	expect(before.every((provider) => !provider.connected)).toBe(true);

	await expect(
		connections.connect({
			apiKey: "invalid-key",
			method: "api-key",
			providerId: "anthropic",
		})
	).rejects.toThrow("Anthropic API key validation failed.");
	expect(
		(await connections.listProviders()).find(
			(provider) => provider.id === "anthropic"
		)?.connected
	).toBe(false);

	await connections.connect({
		apiKey: "valid-key",
		method: "api-key",
		providerId: "anthropic",
	});
	expect(
		(await connections.listProviders()).find(
			(provider) => provider.id === "anthropic"
		)
	).toMatchObject({
		connected: true,
		connectionMethod: "api-key",
		id: "anthropic",
	});
	expect(await connections.authorize("anthropic")).toEqual({
		apiKey: "valid-key",
		kind: "api-key",
	});
	expect(validatedKeys).toEqual(["invalid-key", "valid-key"]);
});
