import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseCodingAgentInstructions } from "@wincode/ai";
import { prepareCodingAgentCall } from "@wincode/ai/server";
import { createConfigStore } from "@/shared/config/config-store";
import { writeFixture } from "@/shared/config/filesystem-test-utils";
import { prepareAgentCall, resolveEffectiveAgentSelection } from "./agent-call";
import {
	configuredAgentVisibleCodingTools,
	resolveAgentRegistry,
} from "./registry";

describe("configured Agents", () => {
	test("resolves a catalog model pin and available default from real config", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-agents-model-default-"));
		const homeRoot = join(root, "home");
		const workspace = join(root, "workspace");
		const xdgConfigHome = join(root, "xdg");

		try {
			await writeFixture(
				join(workspace, "wincode.json"),
				JSON.stringify({
					agents: {
						reviewer: {
							description: "Reviews code",
							model: "openai/gpt-5.5",
							role: "primary",
							variant: "high",
						},
					},
					default_agent: "reviewer",
				})
			);
			const runtime = {
				configStore: createConfigStore({ homeRoot, xdgConfigHome }),
				homeRoot,
				workspace,
			};
			const available = await resolveAgentRegistry(runtime, {
				connectedProviderIds: new Set(["openai"]),
			});

			expect(available.defaultAgentId).toBe("reviewer");
			expect(available.selectableAgents[0]).toMatchObject({
				id: "reviewer",
				model: { modelId: "gpt-5.5", providerId: "openai" },
				variant: "high",
			});
			expect(
				resolveEffectiveAgentSelection(
					available,
					"reviewer",
					{ modelId: "gpt-5.4-mini", providerId: "wincode" },
					undefined
				)
			).toMatchObject({
				agent: "reviewer",
				model: { modelId: "gpt-5.5", providerId: "openai" },
				variant: "high",
			});

			const unavailable = await resolveAgentRegistry(runtime, {
				connectedProviderIds: new Set(["wincode"]),
			});
			expect(unavailable.defaultAgentId).toBe("build");
			expect(
				unavailable.selectableAgents.find(({ id }) => id === "reviewer")
			).toMatchObject({ isAvailable: false });
			expect(unavailable.diagnostics).toMatchObject([
				{ configPath: ["default_agent"], severity: "error" },
			]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("defines, lists, selects, and prepares local execution from real wincode.json", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-agents-json-"));
		const homeRoot = join(root, "home");
		const workspace = join(root, "workspace");
		const xdgConfigHome = join(root, "xdg");

		try {
			await writeFixture(
				join(workspace, "wincode.json"),
				JSON.stringify(
					{
						agents: {
							"code-reviewer": {
								description: "Reviews code for regressions",
								instructions: "Review diffs and flag regressions.",
								role: "primary",
							},
							"issue-researcher": {
								description: "Researches issues",
								instructions: "Read issues and summarize them.",
								role: "subagent",
							},
						},
					},
					null,
					2
				)
			);

			const configStore = createConfigStore({ homeRoot, xdgConfigHome });
			const registry = await resolveAgentRegistry({
				configStore,
				homeRoot,
				workspace,
			});

			expect(registry.diagnostics).toEqual([]);
			expect(registry.agents.map(({ id }) => id)).toEqual([
				"build",
				"plan",
				"code-reviewer",
				"issue-researcher",
			]);
			expect(registry.selectableAgents.map(({ id }) => id)).toEqual([
				"build",
				"code-reviewer",
				"plan",
			]);
			expect(
				registry.agents.find(({ id }) => id === "code-reviewer")
			).toMatchObject({
				description: "Reviews code for regressions",
				displayName: "Code Reviewer",
				instructions: "Review diffs and flag regressions.",
				isConfigured: true,
				isSelectable: true,
				role: "primary",
			});
			expect(
				registry.agents.find(({ id }) => id === "issue-researcher")
			).toMatchObject({
				isSelectable: false,
				role: "subagent",
			});

			const prepared = prepareAgentCall(registry, {
				agent: "code-reviewer",
				model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
				variant: undefined,
			});
			expect(prepared.resolvedAgent).toEqual({
				instructions: "Review diffs and flag regressions.",
				visibleCodingTools: [...configuredAgentVisibleCodingTools],
			});

			const call = prepareCodingAgentCall({
				instructions: "ignored legacy prompt",
				options: {
					model: "gemini-2.5-flash",
					resolvedAgent: prepared.resolvedAgent,
				},
			});
			expect(call.instructions).toBe(
				`${baseCodingAgentInstructions}\n\nReview diffs and flag regressions.`
			);
			expect(call.activeTools).toEqual([
				"read",
				"write",
				"edit",
				"list",
				"glob",
				"grep",
				"shell",
			]);

			// Subagent definitions never produce an executable runtime; the
			// effective selection falls back to Build instead.
			const subagentCall = prepareAgentCall(registry, {
				agent: "issue-researcher",
				model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
				variant: undefined,
			});
			expect(subagentCall.agent).toBe("build");
			expect(subagentCall.resolvedAgent.visibleCodingTools).toEqual([
				"read",
				"write",
				"edit",
				"list",
				"glob",
				"grep",
				"shell",
			]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("loads agents from wincode.jsonc and patches global JSON definitions", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-agents-jsonc-"));
		const homeRoot = join(root, "home");
		const workspace = join(root, "workspace");
		const xdgConfigHome = join(root, "xdg");

		try {
			await writeFixture(
				join(xdgConfigHome, "wincode", "wincode.json"),
				JSON.stringify({
					agents: {
						"code-reviewer": {
							description: "Global reviewer",
							instructions: "Global instructions",
							role: "primary",
						},
					},
				})
			);
			await writeFixture(
				join(workspace, "wincode.jsonc"),
				`{
					// Project overrides win over the global definition.
					"agents": {
						"code-reviewer": {
							"description": "Project reviewer",
							"instructions": "Project instructions",
						},
						"issue-researcher": {
							"role": "subagent",
							"description": "Researches issues",
						},
					},
				}`
			);

			const configStore = createConfigStore({ homeRoot, xdgConfigHome });
			const registry = await resolveAgentRegistry({
				configStore,
				homeRoot,
				workspace,
			});

			expect(registry.diagnostics).toEqual([]);
			expect(registry.agents.map(({ id }) => id)).toEqual([
				"build",
				"plan",
				"code-reviewer",
				"issue-researcher",
			]);
			expect(
				registry.agents.find(({ id }) => id === "code-reviewer")
			).toMatchObject({
				description: "Project reviewer",
				instructions: "Project instructions",
				role: "primary",
			});
			expect(
				registry.selectableAgents.some(({ id }) => id === "issue-researcher")
			).toBe(false);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("omits invalid agents from real config while retaining valid ones", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-agents-invalid-"));
		const homeRoot = join(root, "home");
		const workspace = join(root, "workspace");
		const xdgConfigHome = join(root, "xdg");

		try {
			await writeFixture(
				join(workspace, "wincode.json"),
				JSON.stringify({
					agents: {
						"valid-one": {
							description: "Stays",
							role: "primary",
						},
						"Not Lowercase": {
							description: "Dropped id",
							role: "primary",
						},
						"no-description": {
							role: "primary",
						},
						"unknown-field": {
							description: "Dropped field",
							prompt: "Unsupported alias",
							role: "primary",
						},
					},
				})
			);

			const configStore = createConfigStore({ homeRoot, xdgConfigHome });
			const registry = await resolveAgentRegistry({
				configStore,
				homeRoot,
				workspace,
			});

			expect(registry.configuredAgents.map(({ id }) => id)).toEqual([
				"valid-one",
			]);
			expect(registry.selectableAgents.map(({ id }) => id)).toEqual([
				"build",
				"plan",
				"valid-one",
			]);
			expect(registry.diagnostics.map(({ code }) => code)).toEqual([
				"invalid-agent-id",
				"invalid-agent",
				"invalid-agent",
			]);
			expect(
				registry.diagnostics.every(
					({ origin }) => origin?.path === join(workspace, "wincode.json")
				)
			).toBe(true);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("resolves all four layers, tombstones, scalar replacement, and built-in patches", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-agents-layers-"));
		const homeRoot = join(root, "home");
		const workspace = join(root, "workspace");
		const xdgConfigHome = join(root, "xdg");

		try {
			await writeFixture(
				join(xdgConfigHome, "wincode", "wincode.json"),
				JSON.stringify({
					agents: {
						build: { description: "Global build" },
						helper: {
							description: "Global helper",
							instructions: "Global instructions",
							role: "primary",
						},
						removed: { description: "Remove me", role: "primary" },
					},
				})
			);
			await writeFixture(
				join(homeRoot, ".wincode", "wincode.jsonc"),
				'{"agents":{"helper":{"description":"Home helper"},},}'
			);
			await writeFixture(
				join(workspace, "wincode.json"),
				JSON.stringify({
					agents: {
						helper: null,
						removed: { disable: true },
					},
				})
			);
			await writeFixture(
				join(workspace, ".wincode", "wincode.jsonc"),
				`{
					"agents": {
						"build": { "instructions": "Project build instructions" },
						"helper": {
							"description": "Project helper",
							"role": "all",
						},
						"removed": { "disable": false },
					},
				}`
			);

			const registry = await resolveAgentRegistry({
				configStore: createConfigStore({ homeRoot, xdgConfigHome }),
				homeRoot,
				workspace,
			});

			expect(registry.agents.find(({ id }) => id === "build")).toMatchObject({
				description: "Global build",
				instructions: "Project build instructions",
				role: "primary",
			});
			expect(registry.agents.find(({ id }) => id === "helper")).toMatchObject({
				description: "Project helper",
				instructions: "",
				role: "all",
			});
			expect(registry.agents.find(({ id }) => id === "removed")).toMatchObject({
				description: "Remove me",
				role: "primary",
			});
			expect(registry.diagnostics).toMatchObject([
				{
					code: "invalid-agent",
					configPath: ["agents", "helper"],
					origin: {
						path: join(workspace, "wincode.json"),
						scope: "project",
					},
				},
			]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("keeps one process-lifetime registry snapshot after config changes", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-agents-snapshot-"));
		const homeRoot = join(root, "home");
		const workspace = join(root, "workspace");
		const xdgConfigHome = join(root, "xdg");
		const configPath = join(workspace, "wincode.json");

		try {
			await writeFixture(
				configPath,
				JSON.stringify({
					agents: { helper: { description: "First", role: "primary" } },
				})
			);
			const configStore = createConfigStore({ homeRoot, xdgConfigHome });
			const first = await resolveAgentRegistry({
				configStore,
				homeRoot,
				workspace,
			});
			await writeFile(
				configPath,
				JSON.stringify({
					agents: { helper: { description: "Second", role: "primary" } },
				})
			);
			const second = await resolveAgentRegistry({
				configStore,
				homeRoot,
				workspace,
			});

			expect(first.agents.find(({ id }) => id === "helper")?.description).toBe(
				"First"
			);
			expect(second.agents.find(({ id }) => id === "helper")?.description).toBe(
				"First"
			);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("does not resurrect a lower configured definition after an invalid project patch", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-agents-invalid-patch-"));
		const homeRoot = join(root, "home");
		const workspace = join(root, "workspace");
		const xdgConfigHome = join(root, "xdg");
		const projectPath = join(workspace, ".wincode", "wincode.json");

		try {
			await writeFixture(
				join(xdgConfigHome, "wincode", "wincode.json"),
				JSON.stringify({
					agents: {
						helper: { description: "Global helper", role: "primary" },
					},
				})
			);
			await writeFixture(
				projectPath,
				JSON.stringify({ agents: { helper: { role: "administrator" } } })
			);

			const registry = await resolveAgentRegistry({
				configStore: createConfigStore({ homeRoot, xdgConfigHome }),
				homeRoot,
				workspace,
			});

			expect(registry.configuredAgents).toEqual([]);
			expect(registry.diagnostics).toMatchObject([
				{
					code: "invalid-agent",
					configPath: ["agents", "helper", "role"],
					origin: { path: projectPath, scope: "project" },
					severity: "error",
				},
			]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("enforces registry and text bounds from a real config file", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-agents-bounds-"));
		const homeRoot = join(root, "home");
		const workspace = join(root, "workspace");
		const xdgConfigHome = join(root, "xdg");
		const agents: Record<string, unknown> = {
			build: { description: "x".repeat(513) },
			"long-instructions": {
				description: "Invalid instructions",
				instructions: "x".repeat(12_001),
				role: "primary",
			},
		};
		for (let index = 0; index < 65; index += 1) {
			agents[`valid-${index}`] = { description: "Valid", role: "primary" };
		}

		try {
			await writeFixture(
				join(workspace, "wincode.json"),
				JSON.stringify({ agents })
			);
			const registry = await resolveAgentRegistry({
				configStore: createConfigStore({ homeRoot, xdgConfigHome }),
				homeRoot,
				workspace,
			});

			expect(registry.configuredAgents).toHaveLength(64);
			expect(registry.agents[0]).toMatchObject({
				requiresManualApproval: true,
			});
			expect(registry.diagnostics.map(({ code }) => code)).toEqual([
				"invalid-built-in-agent",
				"invalid-agent",
				"too-many-agents",
			]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("does not leak fields from an invalid lower built-in patch", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "wincode-agents-built-in-safety-")
		);
		const homeRoot = join(root, "home");
		const workspace = join(root, "workspace");
		const xdgConfigHome = join(root, "xdg");

		try {
			await writeFixture(
				join(xdgConfigHome, "wincode", "wincode.json"),
				JSON.stringify({
					agents: {
						build: {
							description: 42,
							instructions: "Must not leak from invalid patch",
						},
					},
				})
			);
			await writeFixture(
				join(workspace, "wincode.json"),
				JSON.stringify({
					agents: { build: { description: "Repaired description" } },
				})
			);

			const registry = await resolveAgentRegistry({
				configStore: createConfigStore({ homeRoot, xdgConfigHome }),
				homeRoot,
				workspace,
			});
			const build = registry.agents.find(({ id }) => id === "build");

			expect(build).toMatchObject({
				description: "Implement changes with read and write access.",
				requiresManualApproval: true,
			});
			expect(build?.instructions).not.toContain("Must not leak");
			expect(registry.diagnostics).toMatchObject([
				{
					code: "invalid-built-in-agent",
					configPath: ["agents", "build", "description"],
					origin: {
						path: join(xdgConfigHome, "wincode", "wincode.json"),
						scope: "global",
					},
				},
			]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});
