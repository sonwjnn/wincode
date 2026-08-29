import { describe, expect, test } from "bun:test";
import type {
	ConfigOrigin,
	ConfigSnapshot,
} from "@/shared/config/config-store";
import { resolveEffectiveAgentSelection } from "./agent-call";
import {
	agentLabelFromId,
	buildAgentRegistry,
	formatAgentDiagnostic,
	MAX_CONFIGURED_AGENT_DESCRIPTION_LENGTH,
	MAX_CONFIGURED_AGENT_INSTRUCTIONS_LENGTH,
	MAX_CONFIGURED_AGENTS,
	resolveActiveAgentId,
	summarizeAgentDiagnostics,
} from "./registry";

const makeSnapshot = (document: Record<string, unknown>): ConfigSnapshot => ({
	diagnostics: [],
	document: document as ConfigSnapshot["document"],
	sourceFor: () => undefined,
	sources: [],
});

describe("buildAgentRegistry", () => {
	test("always includes Build and Plan as selectable built-in agents", () => {
		const registry = buildAgentRegistry(makeSnapshot({}));

		expect(registry.agents.map(({ id }) => id)).toEqual(["build", "plan"]);
		expect(registry.selectableAgents.map(({ id }) => id)).toEqual([
			"build",
			"plan",
		]);
		expect(registry.agents).toMatchObject([
			{ id: "build", isConfigured: false, isSelectable: true, role: "primary" },
			{ id: "plan", isConfigured: false, isSelectable: true, role: "primary" },
		]);
		expect(registry.configuredAgents).toEqual([]);
		expect(registry.diagnostics).toEqual([]);
	});
	test("resolves global and Agent-specific resource profiles", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					reviewer: {
						description: "Reviews code",
						resource_limits: "deep",
						role: "primary",
					},
				},
				resource_limits: "extended",
			})
		);

		expect(registry.resourceProfile).toBe("extended");
		expect(
			registry.agents.find(({ id }) => id === "build")?.resourceProfile
		).toBe("extended");
		expect(
			registry.agents.find(({ id }) => id === "reviewer")?.resourceProfile
		).toBe("deep");
	});

	test("falls back to standard for an invalid global resource profile", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({ resource_limits: "unbounded" })
		);

		expect(registry.resourceProfile).toBe("standard");
		expect(registry.diagnostics).toMatchObject([
			{ code: "invalid-resource-limits", configPath: ["resource_limits"] },
		]);
	});

	test("loads valid primary and all agents as selectable", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					"code-reviewer": {
						description: "Reviews diffs",
						role: "primary",
					},
					"docs-writer": {
						description: "Writes docs",
						instructions: "Write documentation only.",
						role: "all",
					},
				},
			})
		);

		expect(registry.agents.map(({ id }) => id)).toEqual([
			"build",
			"plan",
			"code-reviewer",
			"docs-writer",
		]);
		expect(registry.selectableAgents.map(({ id }) => id)).toEqual([
			"build",
			"code-reviewer",
			"docs-writer",
			"plan",
		]);
		expect(registry.diagnostics).toEqual([]);
	});

	test("resolves catalog model pins and supported variants", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					reviewer: {
						description: "Reviews code",
						model: "openai/gpt-5.5",
						role: "primary",
						variant: "high",
					},
				},
			})
		);

		expect(registry.configuredAgents[0]).toMatchObject({
			model: { modelId: "gpt-5.5", providerId: "openai" },
			variant: "high",
		});
		expect(registry.diagnostics).toEqual([]);
	});

	test("rejects unknown model pins and variants without a supported model", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					"bad-model": {
						description: "Bad model",
						model: "anthropic/gpt-5.5",
						role: "primary",
					},
					"bad-variant": {
						description: "Bad variant",
						role: "primary",
						variant: "high",
					},
				},
			})
		);

		expect(registry.configuredAgents).toEqual([]);
		expect(registry.diagnostics).toHaveLength(2);
	});

	test("puts a valid available default first and falls back visibly to Build", () => {
		const configured = makeSnapshot({
			agents: {
				reviewer: {
					description: "Reviews code",
					role: "primary",
				},
			},
			default_agent: "reviewer",
		});
		const valid = buildAgentRegistry(configured);
		expect(valid.defaultAgentId).toBe("reviewer");
		expect(valid.selectableAgents[0]?.id).toBe("reviewer");
		expect(resolveActiveAgentId(valid)).toBe("reviewer");
		expect(resolveActiveAgentId(valid, "plan")).toBe("plan");
		expect(resolveActiveAgentId(valid, "removed-agent")).toBe("build");

		const invalid = buildAgentRegistry(
			makeSnapshot({ default_agent: "removed-agent" })
		);
		expect(invalid.defaultAgentId).toBe("build");
		expect(invalid.diagnostics).toMatchObject([
			{ configPath: ["default_agent"], severity: "error" },
		]);
	});

	test("keeps disconnected model-pinned Agents visible but unavailable", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					reviewer: {
						description: "Reviews code",
						model: "openai/gpt-5.5",
						role: "primary",
					},
				},
				default_agent: "reviewer",
			}),
			{ connectedProviderIds: new Set(["wincode"]) }
		);

		expect(
			registry.selectableAgents.find(({ id }) => id === "reviewer")
		).toMatchObject({
			isAvailable: false,
			unavailableReason: "Connect openai to use this Agent",
		});
		expect(registry.defaultAgentId).toBe("build");
	});

	test("uses Agent pins per request without changing fallback selection", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					reviewer: {
						description: "Reviews code",
						model: "openai/gpt-5.5",
						role: "primary",
						variant: "high",
					},
				},
			})
		);
		const fallbackModel = {
			modelId: "gpt-5.4-mini",
			providerId: "wincode",
		} as const;

		expect(
			resolveEffectiveAgentSelection(registry, "reviewer", fallbackModel, "low")
		).toMatchObject({
			agent: "reviewer",
			model: { modelId: "gpt-5.5", providerId: "openai" },
			variant: "high",
		});
		expect(
			resolveEffectiveAgentSelection(registry, "plan", fallbackModel, "low")
		).toMatchObject({ agent: "plan", model: fallbackModel, variant: "low" });
	});

	test("retains subagent definitions without making them selectable", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					"issue-researcher": {
						description: "Researches issues",
						role: "subagent",
					},
				},
			})
		);

		expect(registry.agents.map(({ id }) => id)).toContain("issue-researcher");
		expect(
			registry.agents.find(({ id }) => id === "issue-researcher")
		).toMatchObject({
			description: "Researches issues",
			displayName: "Issue Researcher",
			isConfigured: true,
			isSelectable: false,
			role: "subagent",
		});
		expect(
			registry.selectableAgents.some(({ id }) => id === "issue-researcher")
		).toBe(false);
		expect(registry.diagnostics).toEqual([]);
	});

	test("omits agents with invalid ids with a diagnostic", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					"Bad Agent": { description: "x", role: "primary" },
					bad_agent: { description: "x", role: "primary" },
					"bad--agent": { description: "x", role: "primary" },
					"-bad": { description: "x", role: "primary" },
					"bad-": { description: "x", role: "primary" },
				},
			})
		);

		expect(registry.configuredAgents).toEqual([]);
		expect(registry.diagnostics).toHaveLength(5);
		expect(
			registry.diagnostics.every(({ code }) => code === "invalid-agent-id")
		).toBe(true);
	});

	test("accepts single segment and digit led ids", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					triage: { description: "x", role: "primary" },
					"2fa-setup": { description: "x", role: "primary" },
				},
			})
		);

		expect(registry.configuredAgents.map(({ id }) => id)).toEqual([
			"triage",
			"2fa-setup",
		]);
		expect(registry.diagnostics).toEqual([]);
	});

	test("requires a valid role and a non-empty description", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					"no-role": { description: "x" },
					"bad-role": { description: "x", role: "lead" },
					"no-description": { role: "primary" },
					"empty-description": { description: "", role: "primary" },
				},
			})
		);

		expect(registry.configuredAgents).toEqual([]);
		expect(registry.diagnostics).toHaveLength(4);
		expect(
			registry.diagnostics.every(({ code }) => code === "invalid-agent")
		).toBe(true);
	});

	test("accepts optional literal instructions and rejects non-string values", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					"without-instructions": { description: "x", role: "primary" },
					"with-instructions": {
						description: "x",
						instructions: "Do the thing.",
						role: "primary",
					},
					"numeric-instructions": {
						description: "x",
						instructions: 42,
						role: "primary",
					},
					"object-instructions": {
						description: "x",
						instructions: { file: "notes.md" },
						role: "primary",
					},
				},
			})
		);

		expect(registry.configuredAgents.map(({ id }) => id)).toEqual([
			"without-instructions",
			"with-instructions",
		]);
		expect(
			registry.configuredAgents.find(({ id }) => id === "without-instructions")
				?.instructions
		).toBe("");
		expect(
			registry.configuredAgents.find(({ id }) => id === "with-instructions")
				?.instructions
		).toBe("Do the thing.");
		expect(
			registry.diagnostics.filter(({ code }) => code === "invalid-agent")
		).toHaveLength(2);
	});

	test("rejects unknown fields strictly", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					"strict-agent": {
						description: "x",
						prompt: "Not a supported field",
						role: "primary",
					},
				},
			})
		);

		expect(registry.configuredAgents).toEqual([]);
		expect(registry.diagnostics).toMatchObject([{ code: "invalid-agent" }]);
	});

	test("patches supported built-in fields without changing identity or role", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					build: {
						description: "Project build",
						instructions: "Use the project conventions.",
					},
					plan: { description: "Project plan" },
				},
			})
		);

		expect(registry.configuredAgents).toEqual([]);
		expect(registry.agents.map(({ id }) => id)).toEqual(["build", "plan"]);
		expect(registry.agents[0]).toMatchObject({
			description: "Project build",
			id: "build",
			instructions: "Use the project conventions.",
			role: "primary",
		});
		expect(registry.agents[1]).toMatchObject({
			description: "Project plan",
			id: "plan",
			role: "primary",
		});
		expect(registry.diagnostics).toEqual([]);
	});

	test("retains shipped built-ins under a safety ceiling for invalid patches", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					build: { disable: true },
					plan: { description: "Unsafe plan", role: "all" },
				},
			})
		);

		expect(registry.agents).toMatchObject([
			{
				description: "Implement changes with read and write access.",
				id: "build",
				requiresManualApproval: true,
				role: "primary",
			},
			{
				description: "Read-only analysis and planning.",
				id: "plan",
				requiresManualApproval: true,
				role: "primary",
			},
		]);
		expect(registry.diagnostics).toMatchObject([
			{ code: "invalid-built-in-agent", severity: "error" },
			{ code: "invalid-built-in-agent", severity: "error" },
		]);
	});

	test("applies configured-agent tombstones and re-enabled definitions", () => {
		const disabled = buildAgentRegistry(
			makeSnapshot({
				agents: {
					helper: {
						description: "Inherited helper",
						disable: true,
						role: "primary",
					},
				},
			})
		);
		expect(disabled.configuredAgents).toEqual([]);
		expect(disabled.diagnostics).toEqual([]);

		const enabled = buildAgentRegistry(
			makeSnapshot({
				agents: {
					helper: {
						description: "Inherited helper",
						disable: false,
						role: "primary",
					},
				},
			})
		);
		expect(enabled.configuredAgents.map(({ id }) => id)).toEqual(["helper"]);
	});

	test("bounds configured agents to 64 with a diagnostic", () => {
		const agents: Record<string, unknown> = {};
		for (let index = 0; index < MAX_CONFIGURED_AGENTS + 1; index += 1) {
			agents[`agent-${index}`] = { description: "x", role: "primary" };
		}

		const registry = buildAgentRegistry(makeSnapshot({ agents }));

		expect(registry.configuredAgents).toHaveLength(MAX_CONFIGURED_AGENTS);
		expect(registry.diagnostics).toMatchObject([{ code: "too-many-agents" }]);
	});

	test("does not count disabled tombstones toward the configured-agent limit", () => {
		const agents: Record<string, unknown> = {};
		for (let index = 0; index < MAX_CONFIGURED_AGENTS; index += 1) {
			agents[`disabled-${index}`] = { disable: true };
		}
		agents.helper = { description: "Included", role: "primary" };

		const registry = buildAgentRegistry(makeSnapshot({ agents }));

		expect(registry.configuredAgents.map(({ id }) => id)).toEqual(["helper"]);
		expect(registry.diagnostics).toEqual([]);
	});

	test("enforces description and instruction bounds for configured and built-in agents", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					build: {
						description: "x".repeat(
							MAX_CONFIGURED_AGENT_DESCRIPTION_LENGTH + 1
						),
					},
					helper: {
						description: "Helper",
						instructions: "x".repeat(
							MAX_CONFIGURED_AGENT_INSTRUCTIONS_LENGTH + 1
						),
						role: "primary",
					},
				},
			})
		);

		expect(registry.configuredAgents).toEqual([]);
		expect(registry.agents[0]).toMatchObject({
			description: "Implement changes with read and write access.",
			requiresManualApproval: true,
		});
		expect(registry.diagnostics).toMatchObject([
			{ code: "invalid-agent" },
			{ code: "invalid-built-in-agent" },
		]);
	});

	test("rejects a non-object agents record", () => {
		for (const agents of [[], "agents", 42] as const) {
			const registry = buildAgentRegistry(
				makeSnapshot({ agents: agents as unknown as Record<string, unknown> })
			);
			expect(registry.configuredAgents).toEqual([]);
			expect(registry.diagnostics).toMatchObject([
				{ code: "invalid-agents-record" },
			]);
		}
	});

	test("attributes diagnostics to the owning config source", () => {
		const origin: ConfigOrigin = {
			path: "/tmp/project/wincode.json",
			scope: "project",
		};
		const snapshot: ConfigSnapshot = {
			diagnostics: [],
			document: {
				agents: {
					helper: { description: "x", role: "lead" },
				},
			},
			sourceFor: (path) =>
				path[0] === "agents" && path[1] === "helper" ? origin : undefined,
			sources: [],
		};

		const registry = buildAgentRegistry(snapshot);

		expect(registry.diagnostics[0]).toMatchObject({
			code: "invalid-agent",
			configPath: ["agents", "helper", "role"],
			origin: { path: "/tmp/project/wincode.json", scope: "project" },
			severity: "error",
		});
	});

	test("attributes unknown fields to the source that supplied that field", () => {
		const lowerOrigin: ConfigOrigin = {
			path: "/home/user/.config/wincode/wincode.json",
			scope: "global",
		};
		const higherOrigin: ConfigOrigin = {
			path: "/workspace/wincode.json",
			scope: "project",
		};
		const snapshot: ConfigSnapshot = {
			diagnostics: [],
			document: {
				agents: {
					helper: {
						description: "Project helper",
						prompt: "Unsupported lower field",
						role: "primary",
					},
				},
			},
			sourceFor: (path) =>
				path.at(-1) === "prompt" ? lowerOrigin : higherOrigin,
			sources: [],
		};

		const registry = buildAgentRegistry(snapshot);

		expect(registry.configuredAgents).toEqual([]);
		expect(registry.diagnostics).toMatchObject([
			{
				configPath: ["agents", "helper", "prompt"],
				origin: lowerOrigin,
			},
		]);
	});

	test("orders Build first and remaining selectable ids alphabetically", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					zebra: { description: "Z", role: "primary" },
					alpha: { description: "A", role: "all" },
				},
			})
		);

		expect(registry.selectableAgents.map(({ id }) => id)).toEqual([
			"build",
			"alpha",
			"plan",
			"zebra",
		]);
	});
});

describe("agentLabelFromId", () => {
	test("derives deterministic labels from canonical ids", () => {
		expect(agentLabelFromId("build")).toBe("Build");
		expect(agentLabelFromId("plan")).toBe("Plan");
		expect(agentLabelFromId("code-reviewer")).toBe("Code Reviewer");
		expect(agentLabelFromId("2fa-setup")).toBe("2fa Setup");
		expect(agentLabelFromId("triage")).toBe("Triage");
	});

	test("labels are derived from ids, not from config text", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					"my-reviewer": {
						description: "Reviewer for me",
						role: "primary",
					},
				},
			})
		);

		expect(
			registry.agents.find(({ id }) => id === "my-reviewer")?.displayName
		).toBe("My Reviewer");
	});
});

describe("Agent diagnostics", () => {
	test("formats source-attributed details and a bounded startup summary", () => {
		const diagnostic = {
			code: "invalid-agent" as const,
			configPath: ["agents", "helper", "role"],
			message: "Expected a valid role",
			origin: { path: "/workspace/wincode.json", scope: "project" as const },
			severity: "error" as const,
		};

		expect(formatAgentDiagnostic(diagnostic)).toBe(
			"[error] invalid-agent (project /workspace/wincode.json, agents.helper.role): Expected a valid role"
		);
		expect(summarizeAgentDiagnostics([diagnostic])).toBe(
			"Agent config: 1 error, 0 warnings. Open /agents for details."
		);
	});
});

describe("layered permission visibility", () => {
	const withSources = (
		sources: {
			document: Record<string, unknown>;
			path: string;
			scope: "global" | "project";
		}[]
	): ConfigSnapshot => ({
		diagnostics: [],
		document: {} as ConfigSnapshot["document"],
		sourceFor: () => undefined,
		sources: sources as unknown as ConfigSnapshot["sources"],
	});

	test("hides unconditionally denied tools and keeps granular tools visible", () => {
		const registry = buildAgentRegistry(
			withSources([
				{
					document: { permission: { edit: "deny", grep: { "x*": "deny" } } },
					path: "/w/wincode.json",
					scope: "project",
				},
			])
		);
		const build = registry.agents.find(({ id }) => id === "build");

		expect(build?.visibleCodingTools).toEqual([
			"read",
			"list",
			"grep",
			"shell",
		]);
		expect(build?.permission?.edit).toBe("deny");
	});

	test("a valid higher policy restores Plan's hidden write and edit tools", () => {
		const registry = buildAgentRegistry(
			withSources([
				{
					document: { agents: { plan: { permission: { edit: "allow" } } } },
					path: "/w/wincode.json",
					scope: "project",
				},
			])
		);
		const plan = registry.agents.find(({ id }) => id === "plan");

		expect(plan?.visibleCodingTools).toEqual([
			"read",
			"write",
			"edit",
			"list",
			"grep",
		]);
	});
});

describe("malformed top-level policy safety ceiling", () => {
	const withSources = (
		sources: {
			document: Record<string, unknown>;
			path: string;
			scope: "global" | "project";
		}[]
	): ConfigSnapshot => ({
		diagnostics: [],
		document: {} as ConfigSnapshot["document"],
		sourceFor: () => undefined,
		sources: sources as unknown as ConfigSnapshot["sources"],
	});

	test("drives every Agent under a manual-only ceiling and surfaces one diagnostic", () => {
		const registry = buildAgentRegistry(
			withSources([
				{
					document: { permission: "not-an-object" },
					path: "/w/wincode.json",
					scope: "project",
				},
			])
		);

		expect(
			registry.agents.every(
				({ requiresManualApproval }) => requiresManualApproval
			)
		).toBe(true);
		// The same source-level policy fault collapses to a single diagnostic even
		// though it is resolved once per Agent.
		expect(
			registry.diagnostics.filter(
				({ code }) => code === "invalid-permission-policy"
			)
		).toHaveLength(1);
		expect(registry.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "invalid-permission-policy",
				origin: { path: "/w/wincode.json", scope: "project" },
				severity: "error",
			})
		);
	});

	test("valid Agents stay off the ceiling when unrelated definitions are invalid", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					"bad-agent": { role: "primary" },
					"good-agent": { description: "Fine", role: "primary" },
				},
			})
		);

		const good = registry.agents.find(({ id }) => id === "good-agent");
		expect(good?.requiresManualApproval).toBe(false);
		expect(good?.isSelectable).toBe(true);
		// The invalid sibling is reported but does not gate the valid Agent.
		expect(
			registry.diagnostics.some(({ code }) => code === "invalid-agent")
		).toBe(true);
	});

	test("an unmatched action glob surfaces a non-fatal warning without a ceiling", () => {
		const registry = buildAgentRegistry(
			withSources([
				{
					document: { permission: { webfetch: "deny" } },
					path: "/w/wincode.json",
					scope: "project",
				},
			])
		);

		const build = registry.agents.find(({ id }) => id === "build");
		expect(build?.requiresManualApproval).toBe(false);
		expect(
			registry.diagnostics.filter(
				({ code }) => code === "unmatched-permission-action"
			)
		).toHaveLength(1);
	});
});
