import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import { agentIdSchema } from "@wincode/agent-core";
import type { Connections } from "@wincode/ai/connections";
import {
	claimAgentDiagnosticsToast,
	resolveInteractiveAgentRegistry,
} from "@/modules/agents/agent-registry-provider";
import {
	buildAgentRegistry,
	canDeferAgentModelAvailability,
	resolveActiveAgentId,
} from "@/modules/agents/registry";
import type { PluginAgentRegistration } from "@/modules/plugins/public";
import type {
	ConfigRuntime,
	ConfigSnapshot,
} from "@/shared/config/config-store";

test("retains an exact Provider Model pin without claiming it runs on a legacy host", () => {
	const snapshot = fromPartial<ConfigSnapshot>({
		diagnostics: [],
		document: {
			agents: {
				"pinned-helper": {
					description: "Uses a Provider-owned model.",
					model: "plugin-provider/plugin-model",
					role: "primary",
					thinking_level: "high",
				},
			},
		},
		sourceFor: () => undefined,
		sources: [],
	});
	const agent = buildAgentRegistry(snapshot).agents.find(
		({ id }) => id === agentIdSchema.parse("pinned-helper")
	);

	expect(agent).toMatchObject({
		isAvailable: false,
		isSelectable: true,
		model: { modelId: "plugin-model", providerId: "plugin-provider" },
		modelUnavailableReason:
			"Provider Model plugin-provider/plugin-model requires the Provider SDK runtime",
		thinkingLevel: "high",
		unavailableReason:
			"Provider Model plugin-provider/plugin-model requires the Provider SDK runtime",
	});
});

test("defers only a model-connectivity reason and retains other Agent restrictions", () => {
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: {
				agents: {
					"offline-openai-agent": {
						description: "Keeps a catalog-known disconnected pin.",
						model: "openai/gpt-5.6",
						role: "primary",
					},
				},
			},
			sourceFor: () => undefined,
			sources: [],
		}),
		{ connectedProviderIds: new Set() }
	);
	const agent = registry.agents.find(
		({ id }) => id === agentIdSchema.parse("offline-openai-agent")
	);

	if (agent === undefined) {
		throw new Error("The configured Agent should be present in the registry.");
	}
	expect(canDeferAgentModelAvailability(agent)).toBe(true);
	expect(
		canDeferAgentModelAvailability({
			...agent,
			unavailableReason: `${agent.unavailableReason}; Missing required child tool: shell`,
		})
	).toBe(false);
});

test("restores a known Agent with an unavailable pinned model instead of replacing it", () => {
	const unavailableAgentId = agentIdSchema.parse("offline-pinned-agent");
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: {
				agents: {
					[unavailableAgentId]: {
						description: "Keeps a disconnected model pin.",
						model: "openai/gpt-5.6-luna",
						role: "primary",
					},
				},
			},
			sourceFor: () => undefined,
			sources: [],
		}),
		{ connectedProviderIds: new Set() }
	);

	expect(resolveActiveAgentId(registry, unavailableAgentId)).toBe(
		unavailableAgentId
	);
});

test("includes Plugin Agent registrations in the TUI shared Agent catalog", async () => {
	const snapshot = fromPartial<ConfigSnapshot>({
		diagnostics: [],
		document: {},
		sourceFor: () => undefined,
		sources: [],
	});
	const registration: PluginAgentRegistration = {
		agent: {
			description: "A registered subagent.",
			displayName: "Registered Helper",
			id: agentIdSchema.parse("registered-helper"),
			instructions: "Run delegated tasks.",
			role: "subagent",
		},
		source: { path: "package/agents/registered-helper.md", scope: "package" },
	};
	const registry = await resolveInteractiveAgentRegistry(
		fromPartial<ConfigRuntime>({
			configStore: { getSnapshot: async () => snapshot },
			homeRoot: "/home/test",
			workspace: "/workspace",
		}),
		fromPartial<Connections>({ listProviders: async () => [] }),
		{ getAgentRegistrations: () => [registration] }
	);

	expect(
		registry.agents.find(({ id }) => id === registration.agent.id)
	).toMatchObject({
		isAvailable: true,
		role: "subagent",
		source: { kind: "markdown", scope: "package" },
	});
});

test("claims one diagnostics toast per process-lifetime config store", () => {
	const firstStore = {};
	const secondStore = {};

	expect(claimAgentDiagnosticsToast(firstStore)).toBe(true);
	expect(claimAgentDiagnosticsToast(firstStore)).toBe(false);
	expect(claimAgentDiagnosticsToast(secondStore)).toBe(true);
});
