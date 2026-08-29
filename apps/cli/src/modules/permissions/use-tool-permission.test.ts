import { describe, expect, test } from "bun:test";
import { buildAgentRegistry } from "@/modules/agents";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import { createToolPermission } from "./policy";
import { resolveToolPermissionPolicies } from "./use-tool-permission";

const makeSnapshot = (document: Record<string, unknown>): ConfigSnapshot => ({
	diagnostics: [],
	document: document as ConfigSnapshot["document"],
	sourceFor: () => undefined,
	sources: [],
});

describe("resolveToolPermissionPolicies resource profile", () => {
	test("keeps the standard profile while the Agent registry is unavailable", () => {
		const resolved = resolveToolPermissionPolicies(
			null,
			"build",
			createToolPermission
		);

		expect(resolved.resourceLimits.profile).toBe("standard");
	});

	test("resolves the effective Agent's profile for tool execution", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					"deep-review": {
						description: "Review deeply",
						resource_limits: "deep",
						role: "primary",
					},
				},
			})
		);

		const resolved = resolveToolPermissionPolicies(
			registry,
			"deep-review",
			createToolPermission
		);

		expect(resolved.resourceLimits.profile).toBe("deep");
		expect(resolved.resourceLimits.read.maxOutputBytes).toBe(512 * 1024);
	});
});
