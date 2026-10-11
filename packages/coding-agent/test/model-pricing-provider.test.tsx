import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import {
	ModelPricingProvider,
	useModelPricing,
} from "@/modules/model-pricing/context/model-pricing-provider";
import * as fetchModule from "@/modules/model-pricing/fetch-model-pricing";
import * as cacheModule from "@/modules/model-pricing/model-pricing-cache";
import { createEnvironmentRestorer } from "./support/environment";

const TABLE = {
	"openai/gpt-5.6-luna": {
		limits: { context: 400_000 },
		cost: { input: 0.25, output: 2 },
	},
};

const restorePricingUrl = createEnvironmentRestorer([
	"WINCODE_MODEL_PRICING_URL",
]);

afterEach(() => {
	mock.restore();
	restorePricingUrl();
});

const Probe = () => {
	const { source } = useModelPricing();
	return <text>{source}</text>;
};

const renderProvider = (): Promise<TestRendererSetup> =>
	testRender(
		<ModelPricingProvider>
			<Probe />
		</ModelPricingProvider>,
		{ height: 5, width: 40 }
	);

const settle = async (setup: TestRendererSetup): Promise<void> => {
	await Bun.sleep(20);
	await setup.renderOnce();
};

const isolatePricingCache = (): void => {
	spyOn(cacheModule, "readModelPricingCache").mockReturnValue(null);
	spyOn(cacheModule, "writeModelPricingCache").mockImplementation(
		() => undefined
	);
};

test("retries a failed pricing fetch on the next mount", async () => {
	process.env.WINCODE_MODEL_PRICING_URL = "https://pricing.test/retry";
	isolatePricingCache();
	const fetchSpy = spyOn(
		fetchModule,
		"fetchModelPricingTable"
	).mockResolvedValue(null);

	const first = await renderProvider();
	await settle(first);
	expect(fetchSpy).toHaveBeenCalledTimes(1);
	act(() => first.renderer.destroy());

	const second = await renderProvider();
	await settle(second);
	// A null result must not stay cached for the process, or this mount would
	// reuse it and never refresh the table.
	expect(fetchSpy).toHaveBeenCalledTimes(2);
	act(() => second.renderer.destroy());
});

test("labels a table fetched in this session live", async () => {
	process.env.WINCODE_MODEL_PRICING_URL = "https://pricing.test/live";
	isolatePricingCache();
	spyOn(fetchModule, "fetchModelPricingTable").mockResolvedValue(TABLE);

	const setup = await renderProvider();
	await settle(setup);

	expect(setup.captureCharFrame()).toContain("live");
	act(() => setup.renderer.destroy());
});
