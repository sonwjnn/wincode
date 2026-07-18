import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { connectionProviderIds } from "@wincode/ai";
import type { ConnectRequestFor } from "./contract";
import type { ConnectionProgress } from "./credential-schemas";
import {
	type AuthorizationByProvider,
	type CredentialByProvider,
	createProviderRegistry,
	providerOrder,
} from "./provider-registry";

const registry = createProviderRegistry({});
const providerLiteralPattern = /["'](?:anthropic|google|openai|wincode)["']/;
const switchPattern = /\bswitch\s*\(/;

describe("provider registry", () => {
	test("owns provider composition, not facade", () => {
		const facade = readFileSync(
			new URL("./facade.ts", import.meta.url),
			"utf8"
		);
		expect(facade).not.toMatch(providerLiteralPattern);
		expect(facade).not.toMatch(switchPattern);
		expect(facade).toContain("composeProviderServices");
	});

	test("has canonical, complete order", () => {
		expect(providerOrder).toEqual(["anthropic", "google", "openai", "wincode"]);
		expect(new Set(providerOrder).size).toBe(providerOrder.length);
		expect([...providerOrder].sort()).toEqual(
			[...connectionProviderIds].sort()
		);
		expect(Object.keys(registry).sort()).toEqual(
			[...connectionProviderIds].sort()
		);
		for (const id of providerOrder) {
			expect(registry[id].id).toBe(id);
		}
		expect(registry.anthropic.methods).toEqual(["api-key"]);
		expect(registry.google.methods).toEqual(["api-key"]);
		expect(registry.openai.methods).toEqual(["api-key", "browser"]);
		expect(registry.wincode.methods).toEqual(["api-key", "browser"]);
	});
});

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
			? true
			: false
		: false;
type Assert<T extends true> = T;

type ExpectedRequests = {
	anthropic: {
		providerId: "anthropic";
		method: "api-key";
		apiKey: string;
		signal?: AbortSignal;
	};
	google: {
		providerId: "google";
		method: "api-key";
		apiKey: string;
		signal?: AbortSignal;
	};
	openai:
		| {
				providerId: "openai";
				method: "api-key";
				apiKey: string;
				signal?: AbortSignal;
		  }
		| {
				providerId: "openai";
				method: "browser";
				signal?: AbortSignal;
				onProgress?: (status: ConnectionProgress) => void;
				onAuthorizationUrl?: (url: URL) => void;
		  };
	wincode:
		| {
				providerId: "wincode";
				method: "api-key";
				apiKey: string;
				signal?: AbortSignal;
		  }
		| {
				providerId: "wincode";
				method: "browser";
				signal?: AbortSignal;
				onProgress?: (status: ConnectionProgress) => void;
				onAuthorizationUrl?: (url: URL) => void;
		  };
};
type ExpectedAuth = {
	anthropic: { kind: "api-key"; apiKey: string };
	google: { kind: "api-key"; apiKey: string };
	openai:
		| { kind: "api-key"; apiKey: string }
		| { kind: "oauth"; accessToken: string; accountId: string };
	wincode:
		| { kind: "api-key"; apiKey: string }
		| { kind: "bearer"; token: string };
};
type ExpectedCredentials = {
	anthropic: { kind: "api-key"; apiKey: string };
	google: { kind: "api-key"; apiKey: string };
	openai:
		| { kind: "api-key"; apiKey: string }
		| {
				kind: "oauth-session";
				accessToken: string;
				accountId: string;
				expiresAt: string;
				refreshToken: string;
				updatedAt: string;
		  };
	wincode:
		| { kind: "api-key"; apiKey: string }
		| {
				kind: "oauth-session";
				accessToken: string;
				clientId: string;
				expiresAt: string;
				resource: string;
				issuer: string;
				refreshToken: string;
				scope: string;
				tokenType: "Bearer";
				updatedAt: string;
		  };
};
type RequestChecks = Assert<
	Equal<ConnectRequestFor<"anthropic">, ExpectedRequests["anthropic"]>
> &
	Assert<Equal<ConnectRequestFor<"google">, ExpectedRequests["google"]>> &
	Assert<Equal<ConnectRequestFor<"openai">, ExpectedRequests["openai"]>> &
	Assert<Equal<ConnectRequestFor<"wincode">, ExpectedRequests["wincode"]>>;
type AuthChecks = Assert<
	Equal<AuthorizationByProvider["anthropic"], ExpectedAuth["anthropic"]>
> &
	Assert<Equal<AuthorizationByProvider["google"], ExpectedAuth["google"]>> &
	Assert<Equal<AuthorizationByProvider["openai"], ExpectedAuth["openai"]>> &
	Assert<Equal<AuthorizationByProvider["wincode"], ExpectedAuth["wincode"]>>;
type CredentialChecks = Assert<
	Equal<CredentialByProvider, ExpectedCredentials>
>;
type MethodChecks = Assert<
	Equal<typeof registry.anthropic.methods, readonly ["api-key"]>
> &
	Assert<Equal<typeof registry.google.methods, readonly ["api-key"]>> &
	Assert<
		Equal<typeof registry.openai.methods, readonly ["api-key", "browser"]>
	> &
	Assert<
		Equal<typeof registry.wincode.methods, readonly ["api-key", "browser"]>
	>;
const requestChecks: RequestChecks = true;
const authChecks: AuthChecks = true;
const credentialChecks: CredentialChecks = true;
const methodChecks: MethodChecks = true;
expect([
	requestChecks,
	authChecks,
	credentialChecks,
	methodChecks,
]).toHaveLength(4);

const invalidAnthropicBrowser: ConnectRequestFor<"anthropic"> = {
	providerId: "anthropic",
	// @ts-expect-error Anthropic has no browser connection method.
	method: "browser",
	signal: undefined,
};
const invalidGoogleBrowser: ConnectRequestFor<"google"> = {
	providerId: "google",
	// @ts-expect-error Google has no browser connection method.
	method: "browser",
	signal: undefined,
};
expect([invalidAnthropicBrowser, invalidGoogleBrowser]).toHaveLength(2);
