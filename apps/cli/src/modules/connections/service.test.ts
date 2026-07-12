import { describe, expect, mock, test } from "bun:test";
import { connectProvider } from "./connect-provider";

const createBackend = () => {
	let current: unknown = { apiKey: "old-key", kind: "api-key" };
	return {
		async load() {
			return current as never;
		},
		async replaceValidated(_providerId: string, credential: unknown) {
			current = credential;
		},
	};
};

describe("connectProvider", () => {
	test("openai validation uses GET bearer and replaces on success", async () => {
		const calls: Array<{ headers: Headers; method?: string; url: string }> = [];
		const backend = createBackend() as any;
		await connectProvider(
			backend,
			"openai",
			{ apiKey: "sk-openai", kind: "api-key" },
			{
				fetch: async (input, init) => {
					calls.push({
						headers: new Headers(init?.headers),
						method: init?.method,
						url: String(input),
					});
					return new Response(null, { status: 200 });
				},
			}
		);

		expect(calls).toEqual([
			{
				headers: new Headers({ Authorization: "Bearer sk-openai" }),
				method: "GET",
				url: "https://api.openai.com/v1/models",
			},
		]);
		expect(await backend.load()).toEqual({
			apiKey: "sk-openai",
			kind: "api-key",
		});
	});

	test("anthropic validation failure leaves old connection intact and sanitizes error", async () => {
		const backend = createBackend() as any;
		const fetchMock = mock(
			async () => new Response("secret body", { status: 401 })
		);
		await expect(
			connectProvider(
				backend,
				"anthropic",
				{ apiKey: "sk-anthropic", kind: "api-key" },
				{ fetch: fetchMock as any }
			)
		).rejects.toThrow("Anthropic API key validation failed.");
		expect(await backend.load()).toEqual({
			apiKey: "old-key",
			kind: "api-key",
		});
	});

	test("wincode api key needs validator", async () => {
		await expect(
			connectProvider(createBackend() as any, "wincode", {
				apiKey: "sk-wincode",
				kind: "api-key",
			})
		).rejects.toThrow(
			"Wincode API key validation unavailable until hosted validation API exists."
		);
	});
});
