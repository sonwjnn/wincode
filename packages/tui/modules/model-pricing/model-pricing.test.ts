import { expect, test } from "bun:test";
import { resolveModelMetadata } from "./model-pricing";

test("merges live pricing fields without discarding catalog rates (#57)", () => {
	const metadata = resolveModelMetadata(
		{
			"openai/gpt-5.6-luna": {
				cost: { input: 0.3, output: 2 },
			},
		},
		{ modelId: "gpt-5.6-luna", providerId: "openai" }
	);

	expect(metadata?.cost).toEqual({
		cacheRead: 0.02,
		cacheWrite: 0.25,
		input: 0.3,
		output: 2,
	});
});
