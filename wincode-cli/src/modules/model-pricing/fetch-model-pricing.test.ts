import { describe, expect, test } from "bun:test";
import { fetchModelPricingTable } from "./fetch-model-pricing";

const IDS = new Set(["gpt-5.4-mini"]);

const makeFetch = (
	impl: (input: string, init?: RequestInit) => Promise<Response>
): typeof fetch => {
	const fn = (input: string | URL | Request, init?: RequestInit) =>
		impl(String(input), init);
	return fn as typeof fetch;
};

describe("fetchModelPricingTable", () => {
	test("returns parsed table on 200 JSON", async () => {
		const fetchImpl = makeFetch(
			async () =>
				new Response(
					JSON.stringify({
						openai: {
							models: {
								"gpt-5.4-mini": {
									cost: { input: 0.25, output: 2 },
									limit: { context: 400_000 },
								},
							},
						},
					}),
					{ headers: { "content-type": "application/json" }, status: 200 }
				)
		);
		const table = await fetchModelPricingTable(
			"https://example",
			IDS,
			fetchImpl
		);
		expect(table).toEqual({
			"openai/gpt-5.4-mini": {
				contextLimit: 400_000,
				cost: { input: 0.25, output: 2 },
			},
		});
	});

	test("returns null on non-200 status", async () => {
		const fetchImpl = makeFetch(
			async () => new Response("nope", { status: 503 })
		);
		expect(
			await fetchModelPricingTable("https://example", IDS, fetchImpl)
		).toBeNull();
	});

	test("returns null on non-JSON content type", async () => {
		const fetchImpl = makeFetch(
			async () =>
				new Response("<html/>", {
					headers: { "content-type": "text/html" },
					status: 200,
				})
		);
		expect(
			await fetchModelPricingTable("https://example", IDS, fetchImpl)
		).toBeNull();
	});

	test("returns null on invalid JSON body", async () => {
		const fetchImpl = makeFetch(
			async () =>
				new Response("not json", {
					headers: { "content-type": "application/json" },
					status: 200,
				})
		);
		expect(
			await fetchModelPricingTable("https://example", IDS, fetchImpl)
		).toBeNull();
	});

	test("returns null on network error", async () => {
		const fetchImpl = makeFetch(async () => {
			throw new Error("network down");
		});
		expect(
			await fetchModelPricingTable("https://example", IDS, fetchImpl)
		).toBeNull();
	});

	test("returns null on timeout", async () => {
		const fetchImpl = makeFetch(
			async (_url, init) =>
				new Promise<Response>((_, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new Error("aborted"));
					});
				})
		);
		expect(
			await fetchModelPricingTable("https://example", IDS, fetchImpl, 1)
		).toBeNull();
	});

	test("returns null when the parsed table covers too few of the requested ids", async () => {
		const manyIds = new Set([
			"gpt-5.4-mini",
			"o3",
			"o4-mini",
			"claude-fable-5",
		]);
		const fetchImpl = makeFetch(
			async () =>
				new Response(
					JSON.stringify({
						openai: {
							models: {
								"gpt-5.4-mini": {
									cost: { input: 0.25, output: 2 },
									limit: { context: 400_000 },
								},
							},
						},
					}),
					{ headers: { "content-type": "application/json" }, status: 200 }
				)
		);
		expect(
			await fetchModelPricingTable("https://example", manyIds, fetchImpl)
		).toBeNull();
	});

	test("returns an empty table when zero ids are requested", async () => {
		const fetchImpl = makeFetch(
			async () =>
				new Response("{}", {
					headers: { "content-type": "application/json" },
					status: 200,
				})
		);
		expect(
			await fetchModelPricingTable("https://example", new Set(), fetchImpl)
		).toEqual({});
	});
});
