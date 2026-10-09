import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { agentIdSchema } from "@wincode/agent-core";
import {
	applyCapabilityCeilingToAgentRegistry,
	buildAgentRegistry,
	resolveAgentRegistry,
} from "../modules/agents/registry";
import type { PluginAgentRegistration } from "../modules/plugins/public";
import type {
	ConfigRuntime,
	ConfigSnapshot,
} from "../shared/config/config-store";
import { canonicalPathSync } from "../shared/paths/project-roots";

const snapshot = fromPartial<ConfigSnapshot>({
	diagnostics: [],
	document: {},
	sourceFor: () => undefined,
	sources: [],
});

const agent = (
	id: string,
	scope: PluginAgentRegistration["source"]["scope"],
	options: Readonly<{
		tools?: readonly string[];
		requiredTools?: readonly string[];
		projectRoot?: string;
	}> = {}
): PluginAgentRegistration => ({
	agent: {
		description: `${id} agent`,
		displayName: id,
		id: agentIdSchema.parse(id),
		instructions: `${id} instructions`,
		role: "subagent",
	},
	...(options.requiredTools === undefined
		? {}
		: { requiredTools: options.requiredTools }),
	source: {
		path: `/agents/${scope}/${id}.md`,
		...(options.projectRoot === undefined
			? {}
			: { projectRoot: options.projectRoot }),
		scope,
	},
	...(options.tools === undefined ? {} : { tools: options.tools }),
});

test("plugin Markdown agents join the shared catalog with source precedence and capability status", () => {
	const registry = buildAgentRegistry(snapshot, {
		pluginAgentRegistrations: [
			agent("scout", "package"),
			agent("scout", "user"),
			agent("researcher", "builtin", {
				requiredTools: ["web_search"],
				tools: ["read", "web_search"],
			}),
		],
	});
	const scout = registry.agents.find(({ id }) => id === "scout");
	const researcher = registry.agents.find(({ id }) => id === "researcher");

	expect(scout).toMatchObject({
		instructions: "scout instructions",
		isAvailable: true,
		isConfigured: true,
		role: "subagent",
		source: { scope: "user" },
	});
	expect(researcher).toMatchObject({
		isAvailable: false,
		unavailableReason: "Missing required child tools: web_search",
		visibleCodingTools: ["read"],
	});

	const hiddenRequiredToolRegistry = buildAgentRegistry(snapshot, {
		pluginAgentRegistrations: [
			agent("hidden-required-tool", "user", {
				requiredTools: ["shell"],
				tools: ["read"],
			}),
		],
	});
	expect(
		hiddenRequiredToolRegistry.agents.find(
			({ id }) => id === "hidden-required-tool"
		)
	).toMatchObject({
		isAvailable: false,
		unavailableReason: "Missing required child tools: shell",
		visibleCodingTools: ["read"],
	});

	const restrictedWorkerRegistry = buildAgentRegistry(snapshot, {
		capabilityCeiling: { tools: ["read"] },
		pluginAgentRegistrations: [
			agent("restricted-worker", "user", {
				requiredTools: ["shell"],
				tools: ["read", "shell"],
			}),
		],
	});
	expect(
		restrictedWorkerRegistry.agents.find(({ id }) => id === "restricted-worker")
	).toMatchObject({
		isAvailable: false,
		unavailableReason: "Missing required child tools: shell",
	});
});

test("a restricted registry falls back from a default Agent whose required tools are missing", () => {
	const shellDefaultId = agentIdSchema.parse("shell-default");
	const buildAgentId = agentIdSchema.parse("build");
	const defaultAgent = agent("shell-default", "user", {
		requiredTools: ["shell"],
		tools: ["read", "shell"],
	});
	const selectableDefault: PluginAgentRegistration = {
		...defaultAgent,
		agent: { ...defaultAgent.agent, role: "all" },
	};
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: { default_agent: shellDefaultId },
			sourceFor: () => undefined,
			sources: [],
		}),
		{ pluginAgentRegistrations: [selectableDefault] }
	);
	const restrictedRegistry = applyCapabilityCeilingToAgentRegistry(registry, {
		tools: ["read"],
	});

	expect(registry.defaultAgentId).toBe(shellDefaultId);
	expect(restrictedRegistry?.defaultAgentId).toBe(buildAgentId);
	expect(restrictedRegistry?.selectableAgents[0]?.id).toBe(buildAgentId);
});

test("untrusted project registrations stay out of the shared catalog", async () => {
	const projectRoot = await mkdtemp(
		path.join(os.tmpdir(), "wincode-agent-trust-")
	);
	const workspace = path.join(projectRoot, "nested-workspace");
	const projectAgent = agent("project-helper", "project", {
		projectRoot,
	});
	const configRuntime = (trustedProjectRoots: readonly string[]) =>
		fromPartial<ConfigRuntime>({
			configStore: { getSnapshot: async () => snapshot },
			trustedProjectRoots,
			workspace,
		});

	try {
		const denied = await resolveAgentRegistry(configRuntime([]), {
			pluginAgentRegistrations: [projectAgent],
		});
		const trusted = await resolveAgentRegistry(
			configRuntime([canonicalPathSync(projectRoot)]),
			{ pluginAgentRegistrations: [projectAgent] }
		);

		expect(denied.agents.some(({ id }) => id === "project-helper")).toBe(false);
		expect(trusted.agents.some(({ id }) => id === "project-helper")).toBe(true);
	} finally {
		await rm(projectRoot, { force: true, recursive: true });
	}
});
