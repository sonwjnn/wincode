import { describe, expect, test } from "bun:test";
import {
	getConnectionMethodOptions,
	getConnectionProviderDetails,
} from "./connection-dialog-options";

describe("connection dialog options", () => {
	test("lists only supported provider methods", () => {
		expect(
			getConnectionMethodOptions({
				connected: false,
				displayName: "Anthropic",
				id: "anthropic",
				methods: ["api-key"],
			})
		).toEqual([
			{
				id: "api-key",
				label: "API key",
				details: "Paste a key directly into the terminal.",
			},
		]);
		expect(
			getConnectionMethodOptions({
				connected: false,
				displayName: "Wincode",
				id: "wincode",
				methods: ["browser", "api-key"],
			})
		).toHaveLength(2);
		expect(
			getConnectionMethodOptions({
				connected: false,
				displayName: "OpenAI",
				id: "openai",
				methods: ["browser", "api-key"],
			})
		).toHaveLength(2);
		expect(
			getConnectionMethodOptions({
				connected: false,
				displayName: "Google",
				id: "google",
				methods: ["api-key"],
			})
		).toEqual([
			{
				id: "api-key",
				label: "API key",
				details: "Paste a key directly into the terminal.",
			},
		]);
	});

	test("provider metadata stays grounded", () => {
		const openai = {
			connected: true as const,
			connectionMethod: "browser" as const,
			displayName: "OpenAI",
			id: "openai" as const,
			methods: ["browser", "api-key"] as const,
		};
		expect(getConnectionProviderDetails(openai)).toBe(
			"Browser sign-in or API key"
		);
		expect(
			getConnectionProviderDetails({
				connected: false,
				displayName: "Google",
				id: "google",
				methods: ["api-key"],
			})
		).toBe("API key only");
	});
});
