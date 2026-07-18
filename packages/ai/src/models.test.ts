import { describe, expect, test } from "bun:test";
import {
	chatModelSelectionSchema,
	defaultChatModelSelection,
	findSupportedChatModelSelection,
	getChatModelRoute,
	getSupportedModelVariants,
	isHostChatModelSelection,
	isSupportedChatModelSelection,
	normalizeChatModelSelection,
	normalizeModelVariant,
	normalizeModelVariantForModel,
	type SupportedProvider,
	supportedChatModels,
} from "./models";

type AssertEqual<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
			? true
			: never
		: never;

describe("shared chat model selection", () => {
	test("default selection targets wincode gpt-5.4-mini", () => {
		expect(defaultChatModelSelection).toEqual({
			modelId: "gpt-5.4-mini",
			providerId: "wincode",
		});
	});

	test("accepts duplicate model id across providers only for valid pairs", () => {
		expect(
			findSupportedChatModelSelection({
				modelId: "gpt-5.4-mini",
				providerId: "wincode",
			})
		).toMatchObject({
			connectionProviderId: "wincode",
			id: "gpt-5.4-mini",
		});
		expect(
			findSupportedChatModelSelection({
				modelId: "gpt-5.5",
				providerId: "openai",
			})
		).toMatchObject({
			connectionProviderId: "openai",
			id: "gpt-5.5",
		});
		expect(
			chatModelSelectionSchema.safeParse({
				modelId: "gpt-5.4-mini",
				providerId: "wincode",
			})
		).toMatchObject({ success: true });
		expect(
			chatModelSelectionSchema.safeParse({
				modelId: "gpt-5.4-mini",
				providerId: "anthropic",
			})
		).toMatchObject({ success: false });
		expect(
			isSupportedChatModelSelection({
				modelId: "gpt-5.4-mini",
				providerId: "wincode",
			})
		).toBe(true);
	});

	test("enforces strict provider/model pairs in selection normalization", () => {
		expect(
			normalizeChatModelSelection({
				modelId: "gpt-5.4-mini",
				providerId: "wincode",
			})
		).toEqual({ modelId: "gpt-5.4-mini", providerId: "wincode" });
		expect(
			normalizeChatModelSelection({
				modelId: "gpt-5.4-mini",
				providerId: "anthropic",
			})
		).toBeNull();
		expect(
			chatModelSelectionSchema.safeParse({
				modelId: "gpt-5.4-mini",
				providerId: "anthropic",
			})
		).toMatchObject({
			success: false,
		});
	});

	test("rejects invalid model/provider pairs", () => {
		expect(
			chatModelSelectionSchema.safeParse({
				modelId: "gpt-5.4-mini",
				providerId: "anthropic",
			})
		).toMatchObject({ success: false });
		expect(
			chatModelSelectionSchema.safeParse({
				modelId: "gpt-5.4-mini",
			})
		).toMatchObject({ success: false });
	});

	test("normalizes legacy ids to host selections", () => {
		expect(normalizeChatModelSelection("gemini-3.5-flash")).toEqual({
			modelId: "gemini-2.5-flash",
			providerId: "wincode",
		});
		expect(normalizeChatModelSelection("gpt-5.4-mini")).toEqual({
			modelId: "gpt-5.4-mini",
			providerId: "wincode",
		});
		expect(normalizeChatModelSelection("claude-3.5-sonnet")).toBeNull();
		expect(normalizeChatModelSelection("unknown-model")).toBeNull();
	});

	test("keeps SupportedProvider export compatible", () => {
		const provider: SupportedProvider = "openai";
		const exactProviderType: AssertEqual<
			SupportedProvider,
			"anthropic" | "google" | "openai"
		> = true;

		expect(provider).toBe("openai");
		expect(exactProviderType).toBe(true);
	});

	test("keeps unique provider/model keys across catalog", () => {
		const keys = supportedChatModels.map(
			(model) => `${model.connectionProviderId}/${model.id}`
		);

		expect(new Set(keys).size).toBe(keys.length);
	});

	test("tracks host versus direct catalog selections", () => {
		for (const model of supportedChatModels) {
			const selection = {
				modelId: model.id,
				providerId: model.connectionProviderId,
			};

			expect(findSupportedChatModelSelection(selection)).toEqual(model);
			expect(getChatModelRoute(selection)).toBe(model.route);
			expect(isHostChatModelSelection(selection)).toBe(
				model.route === "hosted"
			);
			expect(normalizeChatModelSelection(selection)).toEqual(selection);
		}
		expect(
			getChatModelRoute({
				modelId: "gpt-5.4-mini",
				providerId: "anthropic",
			})
		).toBeNull();
	});

	test("resolves supported variants for selections", () => {
		expect(
			getSupportedModelVariants({
				modelId: "claude-sonnet-5",
				providerId: "anthropic",
			})
		).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(
			normalizeModelVariant(
				{ modelId: "gemma-4-31b-it", providerId: "google" },
				"high"
			)
		).toBeUndefined();
		expect(
			normalizeModelVariant(
				{ modelId: "gpt-5.6", providerId: "openai" },
				"none"
			)
		).toBe("none");
	});

	test("uses the selected catalog entry when hosted and direct variants differ", () => {
		const hostedModel = {
			connectionProviderId: "wincode",
			id: "gemini-2.5-flash",
			variants: ["none"],
		} as const;

		expect(normalizeModelVariantForModel(hostedModel, "none")).toBe("none");
		expect(normalizeModelVariantForModel(hostedModel, "max")).toBeUndefined();
	});
});
