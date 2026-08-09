import { describe, expect, test } from "bun:test";
import type {
	ConfigOrigin,
	ConfigSnapshot,
} from "@/shared/config/config-store";
import {
	agentLabelFromId,
	buildAgentRegistry,
	configuredAgentVisibleCodingTools,
	MAX_CONFIGURED_AGENTS,
	resolveExecutableAgentRuntime,
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

	test("rejects configured definitions for reserved built-in ids", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					build: { description: "Custom build", role: "primary" },
					plan: { description: "Custom plan", role: "primary" },
				},
			})
		);

		expect(registry.configuredAgents).toEqual([]);
		expect(registry.agents.map(({ id }) => id)).toEqual(["build", "plan"]);
		expect(registry.diagnostics).toMatchObject([
			{ code: "reserved-agent-id" },
			{ code: "reserved-agent-id" },
		]);
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
			origin: { path: "/tmp/project/wincode.json", scope: "project" },
		});
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

describe("resolveExecutableAgentRuntime", () => {
	test("resolves primary and all agents to the selected runtime", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					"code-reviewer": {
						description: "Reviews diffs",
						instructions: "Review diffs.",
						role: "primary",
					},
					"docs-writer": {
						description: "Writes docs",
						role: "all",
					},
				},
			})
		);

		expect(resolveExecutableAgentRuntime(registry, "code-reviewer")).toEqual({
			instructions: "Review diffs.",
			visibleCodingTools: [...configuredAgentVisibleCodingTools],
		});
		expect(
			resolveExecutableAgentRuntime(registry, "docs-writer")?.instructions
		).toBe("");
	});

	test("never resolves subagent or unknown ids", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					"issue-researcher": {
						description: "Researches issues",
						instructions: "Summarize issues.",
						role: "subagent",
					},
				},
			})
		);

		expect(resolveExecutableAgentRuntime(registry, "issue-researcher")).toBe(
			undefined
		);
		expect(resolveExecutableAgentRuntime(registry, "does-not-exist")).toBe(
			undefined
		);
	});

	test("resolves built-in agents from the registry", () => {
		const registry = buildAgentRegistry(makeSnapshot({}));

		expect(
			resolveExecutableAgentRuntime(registry, "build")?.visibleCodingTools
		).toEqual(["read", "write", "edit", "list", "grep"]);
		expect(
			resolveExecutableAgentRuntime(registry, "plan")?.visibleCodingTools
		).toEqual(["read", "list", "grep"]);
	});

	test("returns undefined when the registry is unavailable", () => {
		expect(resolveExecutableAgentRuntime(null, "build")).toBe(undefined);
	});
});
