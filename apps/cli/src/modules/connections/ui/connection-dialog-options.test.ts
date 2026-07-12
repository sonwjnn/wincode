import { describe, expect, test } from "bun:test";
import {
	CONNECTION_PROVIDERS,
	getConnectionMethodOptions,
	getConnectionProviderOption,
} from "./connection-dialog-options";

describe("connection dialog options", () => {
	test("lists only supported provider methods", () => {
		expect(getConnectionMethodOptions("anthropic")).toEqual([
			{
				id: "api-key",
				label: "API key",
				details: "Paste a key directly into the terminal.",
			},
		]);
		expect(getConnectionMethodOptions("wincode")).toHaveLength(2);
		expect(getConnectionMethodOptions("openai")).toHaveLength(2);
	});

	test("provider metadata stays grounded", () => {
		expect(CONNECTION_PROVIDERS.map((provider) => provider.id)).toEqual([
			"wincode",
			"openai",
			"anthropic",
		]);
		expect(getConnectionProviderOption("openai")).toMatchObject({
			label: "OpenAI",
			details: "Browser sign-in or API key",
		});
		expect(getConnectionMethodOptions("wincode")).toContainEqual({
			id: "browser",
			label: "Browser sign-in",
			details: "Open a browser and copy the URL.",
		});
	});
});
