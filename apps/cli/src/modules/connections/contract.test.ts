import { describe, expect, test } from "bun:test";
import type { AuthorizationByProvider, Connections } from "./contract";
import { credentialSchemas } from "./contract";

type Assert<T extends true> = T;
type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;

async function _compileOnlyAuthorizeChecks(
	connections: Connections
): Promise<void> {
	const anthropic = await connections.authorize("anthropic");
	const google = await connections.authorize("google");
	const openai = await connections.authorize("openai");
	const wincode = await connections.authorize("wincode");
	const _anthropic: Assert<
		Equal<typeof anthropic, AuthorizationByProvider["anthropic"]>
	> = true;
	const _google: Assert<
		Equal<typeof google, AuthorizationByProvider["google"]>
	> = true;
	const _openai: Assert<
		Equal<typeof openai, AuthorizationByProvider["openai"]>
	> = true;
	const _wincode: Assert<
		Equal<typeof wincode, AuthorizationByProvider["wincode"]>
	> = true;
}

type ParseResult<T extends keyof typeof credentialSchemas> = ReturnType<
	(typeof credentialSchemas)[T]["parse"]
>;

const _anthropicCredentialSchemaCheck: Assert<
	Equal<Awaited<ParseResult<"anthropic">>, { apiKey: string; kind: "api-key" }>
> = true;

const _googleCredentialSchemaCheck: Assert<
	Equal<Awaited<ParseResult<"google">>, { apiKey: string; kind: "api-key" }>
> = true;

const _openaiCredentialSchemaCheck: Assert<
	Equal<
		Awaited<ParseResult<"openai">>,
		| { apiKey: string; kind: "api-key" }
		| {
				accessToken: string;
				accountId: string;
				expiresAt: string;
				kind: "oauth-session";
				refreshToken: string;
				updatedAt: string;
		  }
	>
> = true;

const _wincodeCredentialSchemaCheck: Assert<
	Equal<
		Awaited<ParseResult<"wincode">>,
		| { apiKey: string; kind: "api-key" }
		| {
				accessToken: string;
				clientId: string;
				expiresAt: string;
				issuer: string;
				kind: "oauth-session";
				refreshToken: string;
				scope: string;
				tokenType: "Bearer";
				updatedAt: string;
				resource: string;
		  }
	>
> = true;

describe("connections contract", () => {
	test("credential schemas stay strict", () => {
		expect(() =>
			credentialSchemas.openai.parse({
				apiKey: "x",
				kind: "api-key",
				extra: true,
			})
		).toThrow();
	});
});
