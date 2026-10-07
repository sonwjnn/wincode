import { describe, expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import { buildAgentRegistry } from "@/modules/agents";
import type { AgentRegistry } from "@/modules/agents/registry";
import type { PermissionService } from "@/modules/permissions/permission-service";
import { createToolPermission } from "@/modules/permissions/policy";
import {
	createToolPermissionPolicyState,
	createToolPermissionRuntime,
	resolveToolPermissionPolicies,
} from "@/modules/permissions/tool-permission-runtime";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import { agentId } from "../support/identifiers";

const makeSnapshot = (document: Record<string, unknown>): ConfigSnapshot => ({
	diagnostics: [],
	document: fromPartial<ConfigSnapshot["document"]>(document),
	sourceFor: () => undefined,
	sources: [],
});

describe("ToolPermissionRuntime fallback", () => {
	test("keeps each Agent's Permission when the registry becomes unavailable", async () => {
		const alphaId = agentId("alpha");
		const betaId = agentId("beta");
		const document = {
			agents: {
				alpha: {
					description: "Restrictive Agent",
					model: "openai/gpt-5.6-luna",
					permission: { read: "deny" },
					role: "primary",
				},
				beta: {
					description: "Permissive Agent",
					model: "openai/gpt-5.6-luna",
					permission: { read: "allow" },
					role: "primary",
				},
			},
		};
		let registry: AgentRegistry | null = buildAgentRegistry({
			...makeSnapshot(document),
			sources: [
				{
					document: fromPartial<ConfigSnapshot["document"]>(document),
					path: "/tmp/agent-permission-fallback.json",
					scope: "project",
				},
			],
		});
		const runtime = createToolPermissionRuntime({
			agent: alphaId,
			getRegistry: () => registry,
			policyState: createToolPermissionPolicyState(),
			service: fromPartial<PermissionService>({}),
			workspace: "/tmp",
		});

		expect(
			(await runtime.resolvePermissionForAgent(alphaId)).decide(
				"read",
				"file.ts"
			)
		).toBe("deny");
		expect(
			(await runtime.resolvePermissionForAgent(betaId)).decide(
				"read",
				"file.ts"
			)
		).toBe("allow");

		registry = null;

		expect(
			(await runtime.resolvePermissionForAgent(alphaId)).decide(
				"read",
				"file.ts"
			)
		).toBe("deny");
		expect(
			(await runtime.resolvePermissionForAgent(betaId)).decide(
				"read",
				"file.ts"
			)
		).toBe("allow");
		expect(
			(await runtime.resolvePermissionForAgent(agentId("unresolved"))).decide(
				"read",
				"file.ts"
			)
		).toBe("deny");
	});
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
