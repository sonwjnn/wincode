import { describe, expect, test } from "bun:test";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import {
	DEFAULT_COMPACTION_SETTINGS,
	resolveCompactionSettings,
} from "./config";

const snapshot = (document: Record<string, unknown>): ConfigSnapshot => ({
	diagnostics: [],
	document,
	sourceFor: (path) =>
		path[0] === "compaction"
			? { path: "/workspace/wincode.json", scope: "project" }
			: undefined,
	sources: [],
});

describe("resolveCompactionSettings", () => {
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
			path: "/workspace/wincode.json",
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
		expect(settings.midTurnAvailable).toBe(true);
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
