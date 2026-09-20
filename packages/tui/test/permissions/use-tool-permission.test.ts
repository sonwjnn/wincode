import { describe, expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import { buildAgentRegistry } from "@/modules/agents";
import { createToolPermission } from "@/modules/permissions/policy";
import { resolveToolPermissionPolicies } from "@/modules/permissions/tool-permission-runtime";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import { agentId } from "../support/identifiers";

const makeSnapshot = (document: Record<string, unknown>): ConfigSnapshot => ({
	diagnostics: [],
	document: fromPartial<ConfigSnapshot["document"]>(document),
	sourceFor: () => undefined,
	sources: [],
});

describe("resolveToolPermissionPolicies resource profile", () => {
	test("keeps the standard profile while the Agent registry is unavailable", () => {
		const resolved = resolveToolPermissionPolicies(
			null,
			agentId("build"),
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
			agentId("deep-review"),
			createToolPermission
		);

		expect(resolved.resourceLimits.profile).toBe("deep");
		expect(resolved.resourceLimits.read.maxOutputBytes).toBe(512 * 1024);
	});
});
