import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import { agentIdSchema } from "@wincode/agent-core";
import type { Connections } from "@wincode/ai/connections";
import {
	claimAgentDiagnosticsToast,
	resolveInteractiveAgentRegistry,
} from "@/modules/agents/agent-registry-provider";
import type { PluginAgentRegistration } from "@/modules/plugins/public";
import type {
	ConfigRuntime,
	ConfigSnapshot,
} from "@/shared/config/config-store";

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
