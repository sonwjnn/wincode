import { describe, expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import type { ProviderModel } from "@wincode/ai";
import {
	DEFAULT_PROVIDER_MODEL_SELECTION,
	type ProviderModelSelection,
	parseProviderModelSelection,
} from "@/modules/providers/provider-model-selection";
import {
	DEFAULT_COMPACTION_SETTINGS,
	resolveCompactionSettings,
} from "@/modules/sessions/compaction/config";
import { createCompactionSettingsOperations } from "@/modules/sessions/compaction/settings-operations";
import type { ConfigSnapshot, ConfigStore } from "@/shared/config/config-store";

const snapshot = (document: Record<string, unknown>): ConfigSnapshot => ({
	diagnostics: [],
	document,
	sourceFor: (path) =>
		path[0] === "compaction"
			? { path: "/workspace/.wincode/settings.json", scope: "project" }
			: undefined,
	sources: [],
});

describe("resolveCompactionSettings", () => {
	test("applies an exact slash-preserving model override per field", () => {
		const model = parseProviderModelSelection("openai/gpt-4.1/2025-04-14");
		if (model === null) {
			throw new Error("The Provider Model fixture was invalid.");
		}
		const settings = resolveCompactionSettings({
			contextLimit: 100_000,
			model,
			snapshot: {
				diagnostics: [],
				document: {
					compaction: {
						keepRecentTokens: 18_000,
						modelOverrides: {
							"openai/gpt-4.1/2025-04-14": { reserveTokens: 30_000 },
						},
						reserveTokens: 10_000,
					},
				},
				sourceFor: (path) =>
					path[1] === "modelOverrides"
						? { path: "/home/user/.wincode/settings.json", scope: "global" }
						: { path: "/workspace/.wincode/settings.json", scope: "project" },
				sources: [],
			},
		});

		expect(settings.desired).toMatchObject({
			keepRecentTokens: 18_000,
			reserveTokens: 30_000,
		});
		expect(settings.resolved).toMatchObject({
			keepRecentTokens: 18_000,
			reserveTokens: 30_000,
		});
		expect(settings.settingPaths.keepRecentTokens).toEqual([
			"compaction",
			"keepRecentTokens",
		]);
		expect(settings.settingPaths.reserveTokens).toEqual([
			"compaction",
			"modelOverrides",
			"openai/gpt-4.1/2025-04-14",
			"reserveTokens",
		]);
		expect(settings.sources.keepRecentTokens).toEqual({
			kind: "config",
			path: "/workspace/.wincode/settings.json",
			scope: "project",
		});
		expect(settings.sources.reserveTokens).toEqual({
			kind: "config",
			path: "/home/user/.wincode/settings.json",
			scope: "global",
		});
	});

	test("applies session overrides after exact-model values field by field", () => {
		const model = parseProviderModelSelection("openai/gpt-4.1/2025-04-14");
		if (model === null) {
			throw new Error("The Provider Model fixture was invalid.");
		}
		const settings = resolveCompactionSettings({
			contextLimit: 100_000,
			model,
			sessionOverrides: { keepRecentTokens: 7000 },
			snapshot: snapshot({
				compaction: {
					modelOverrides: {
						"openai/gpt-4.1/2025-04-14": {
							keepRecentTokens: 14_000,
							reserveTokens: 30_000,
						},
					},
				},
			}),
		});

		expect(settings.desired).toMatchObject({
			keepRecentTokens: 7000,
			reserveTokens: 30_000,
		});
		expect(settings.sources.keepRecentTokens).toEqual({ kind: "session" });
		expect(settings.sources.reserveTokens.kind).toBe("config");
	});

	test("diagnoses malformed per-model identity keys", () => {
		const model = parseProviderModelSelection("openai/gpt-4.1/2025-04-14");
		if (model === null) {
			throw new Error("The Provider Model fixture was invalid.");
		}
		const settings = resolveCompactionSettings({
			contextLimit: 100_000,
			model,
			snapshot: snapshot({
				compaction: {
					modelOverrides: {
						"not-a-provider-model": { reserveTokens: 9000 },
					},
				},
			}),
		});

		expect(settings.reserveTokens).toBe(
			DEFAULT_COMPACTION_SETTINGS.reserveTokens
		);
		expect(settings.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "invalid-value",
				configPath: ["compaction", "modelOverrides", "not-a-provider-model"],
				severity: "error",
			})
		);
	});

	test("diagnoses per-model fields outside the supported budgets", () => {
		const model = parseProviderModelSelection("openai/gpt-4.1/2025-04-14");
		if (model === null) {
			throw new Error("The Provider Model fixture was invalid.");
		}
		const settings = resolveCompactionSettings({
			contextLimit: 100_000,
			model,
			snapshot: snapshot({
				compaction: {
					modelOverrides: {
						"openai/gpt-4.1/2025-04-14": { auto: false },
					},
				},
			}),
		});

		expect(settings.auto).toBe(true);
		expect(settings.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "invalid-value",
				configPath: [
					"compaction",
					"modelOverrides",
					"openai/gpt-4.1/2025-04-14",
					"auto",
				],
				severity: "error",
			})
		);
	});

	test("diagnoses an invalid matching override and retains field-wise fallback", () => {
		const model = parseProviderModelSelection("openai/gpt-4.1/2025-04-14");
		if (model === null) {
			throw new Error("The Provider Model fixture was invalid.");
		}
		const settings = resolveCompactionSettings({
			contextLimit: 100_000,
			model,
			snapshot: snapshot({
				compaction: {
					keepRecentTokens: 12_000,
					modelOverrides: {
						"openai/gpt-4.1/2025-04-14": { reserveTokens: 0 },
					},
					reserveTokens: 8000,
				},
			}),
		});

		expect(settings.reserveTokens).toBe(8000);
		expect(settings.settingPaths.reserveTokens).toEqual([
			"compaction",
			"reserveTokens",
		]);
		expect(settings.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "invalid-value",
				configPath: [
					"compaction",
					"modelOverrides",
					"openai/gpt-4.1/2025-04-14",
					"reserveTokens",
				],
				severity: "error",
			})
		);
	});

	test("clamps exact-model budgets to the selected model's small window", () => {
		const model = parseProviderModelSelection("openai/gpt-4.1/2025-04-14");
		if (model === null) {
			throw new Error("The Provider Model fixture was invalid.");
		}
		const settings = resolveCompactionSettings({
			contextLimit: 32_000,
			model,
			snapshot: snapshot({
				compaction: {
					modelOverrides: {
						"openai/gpt-4.1/2025-04-14": {
							keepRecentTokens: 30_000,
							reserveTokens: 30_000,
						},
					},
				},
			}),
		});

		expect(settings.desired).toMatchObject({
			keepRecentTokens: 30_000,
			reserveTokens: 30_000,
		});
		expect(settings.resolved).toMatchObject({
			keepRecentTokens: 8000,
			reserveTokens: 16_000,
		});
		expect(settings.thresholdTokens).toBe(16_000);
	});

	test("uses defaults and clamps desired values to a small model", () => {
		const settings = resolveCompactionSettings({
			contextLimit: 32_000,
			snapshot: snapshot({
				compaction: {
					keepRecentTokens: 30_000,
					reserveTokens: 30_000,
				},
			}),
		});

		expect(settings.desired).toMatchObject({
			keepRecentTokens: 30_000,
			reserveTokens: 30_000,
		});
		expect(settings.resolved).toMatchObject({
			keepRecentTokens: 8000,
			reserveTokens: 16_000,
		});
		expect(settings.thresholdTokens).toBe(16_000);
		expect(settings.sources.keepRecentTokens).toEqual({
			kind: "config",
			path: "/workspace/.wincode/settings.json",
			scope: "project",
		});
	});

	test("keeps manual compaction available when the context limit is unknown", () => {
		const settings = resolveCompactionSettings();

		expect(settings.enabled).toBe(DEFAULT_COMPACTION_SETTINGS.enabled);
		expect(settings.autoAvailable).toBe(false);
		expect(settings.overflowRecoveryAvailable).toBe(true);
		expect(settings.thresholdTokens).toBeNull();
		expect(settings.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "unknown-context-limit",
				severity: "warning",
			})
		);
	});

	test("passes the selected model identity into settings resolution", async () => {
		const model = parseProviderModelSelection("openai/gpt-4.1/2025-04-14");
		const switchedModel = parseProviderModelSelection(
			"anthropic/gpt-4.1/2025-04-14"
		);
		if (model === null || switchedModel === null) {
			throw new Error("The Provider Model fixture was invalid.");
		}
		const providerModel = (
			selection: ProviderModelSelection
		): ProviderModel => ({
			limits: { contextWindowTokens: 100_000 },
			modelId: selection.modelId,
			protocolId: "fixture",
			providerId: selection.providerId,
		});
		const operations = createCompactionSettingsOperations({
			configStore: fromPartial<ConfigStore>({
				getSnapshot: async () =>
					snapshot({
						compaction: {
							modelOverrides: {
								"openai/gpt-4.1/2025-04-14": { reserveTokens: 30_000 },
								"anthropic/gpt-4.1/2025-04-14": { reserveTokens: 8000 },
							},
						},
					}),
			}),
			workspace: "/workspace",
		});

		const first = await operations.getCompactionSettings(
			model,
			providerModel(model)
		);
		const afterModelSwitch = await operations.getCompactionSettings(
			switchedModel,
			providerModel(switchedModel)
		);

		expect(first.reserveTokens).toBe(30_000);
		expect(first.modelContextLimit).toBe(100_000);
		expect(afterModelSwitch.reserveTokens).toBe(8000);
		expect(afterModelSwitch.modelContextLimit).toBe(100_000);
	});

	test("keeps context unknown when a Provider Model is not supplied", async () => {
		const operations = createCompactionSettingsOperations({
			configStore: fromPartial<ConfigStore>({
				getSnapshot: async () => snapshot({}),
			}),
			workspace: "/workspace",
		});

		const settings = await operations.getCompactionSettings(
			DEFAULT_PROVIDER_MODEL_SELECTION,
			null
		);

		expect(settings.modelContextLimit).toBeNull();
		expect(settings.autoAvailable).toBe(false);
	});

	test("does not guess context limits for an absent Provider Model", async () => {
		const operations = createCompactionSettingsOperations({
			configStore: fromPartial<ConfigStore>({
				getSnapshot: async () => snapshot({}),
			}),
			workspace: "/workspace",
		});

		const model = parseProviderModelSelection(
			"unknown-provider/unlisted-model"
		);
		if (model === null) {
			throw new Error("The unknown Provider Model fixture was invalid.");
		}
		const settings = await operations.getCompactionSettings(model, null);

		expect(settings.modelContextLimit).toBeNull();
		expect(settings.autoAvailable).toBe(false);
		expect(settings.enabled).toBe(true);
	});

	test("retains the root config path for legacy top-level settings", () => {
		const settings = resolveCompactionSettings({
			snapshot: snapshot({ auto: false }),
		});

		expect(settings.configPath).toEqual([]);
		expect(settings.desired.auto).toBe(false);
	});

	test("surfaces a legacy auto value beside a nested compaction config", () => {
		const settings = resolveCompactionSettings({
			snapshot: {
				diagnostics: [],
				document: {
					auto: false,
					compaction: { reserveTokens: 1000 },
				},
				sourceFor: (path) => {
					if (path[0] === "auto") {
						return {
							path: "/workspace/.wincode/settings.json",
							scope: "project",
						};
					}
					if (path[0] === "compaction") {
						return {
							path: "/home/user/.wincode/settings.json",
							scope: "global",
						};
					}
					return;
				},
				sources: [],
			},
		});

		expect(settings.desired.auto).toBe(false);
		expect(settings.sources.auto).toEqual({
			kind: "config",
			path: "/workspace/.wincode/settings.json",
			scope: "project",
		});
		expect(settings.settingPaths.auto).toEqual(["auto"]);
	});
	test("reports invalid values and lets session overrides reset JSON behavior", () => {
		const settings = resolveCompactionSettings({
			contextLimit: 100_000,
			sessionOverrides: { auto: false, reserveTokens: 2000 },
			snapshot: snapshot({
				compaction: {
					auto: "sometimes",
					reserveTokens: 0,
				},
			}),
		});

		expect(settings.auto).toBe(false);
		expect(settings.reserveTokens).toBe(2000);
		expect(settings.sources.auto).toEqual({ kind: "session" });
		expect(settings.sources.reserveTokens).toEqual({ kind: "session" });
		expect(settings.diagnostics).toHaveLength(2);
		expect(settings.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ configPath: ["compaction", "auto"] }),
				expect.objectContaining({
					configPath: ["compaction", "reserveTokens"],
				}),
			])
		);
	});
});
