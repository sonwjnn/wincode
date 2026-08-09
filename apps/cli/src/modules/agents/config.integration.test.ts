import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseCodingAgentInstructions } from "@wincode/ai";
import { prepareCodingAgentCall } from "@wincode/ai/server";
import { createConfigStore } from "@/shared/config/config-store";
import { writeFixture } from "@/shared/config/filesystem-test-utils";
import {
	configuredAgentVisibleCodingTools,
	resolveAgentRegistry,
	resolveExecutableAgentRuntime,
} from "./registry";

describe("configured Agents", () => {
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

			const runtime = resolveExecutableAgentRuntime(registry, "code-reviewer");
			expect(runtime).toEqual({
				instructions: "Review diffs and flag regressions.",
				visibleCodingTools: [...configuredAgentVisibleCodingTools],
			});

			const prepared = prepareCodingAgentCall({
				instructions: "ignored legacy prompt",
				options: { model: "gemini-2.5-flash", resolvedAgent: runtime },
			});
			expect(prepared.instructions).toBe(
				`${baseCodingAgentInstructions}\n\nReview diffs and flag regressions.`
			);
			expect(prepared.activeTools).toEqual([
				"read",
				"write",
				"edit",
				"list",
				"grep",
			]);

			expect(resolveExecutableAgentRuntime(registry, "issue-researcher")).toBe(
				undefined
			);
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
							model: "wincode/gemini-2.5-flash",
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
});
