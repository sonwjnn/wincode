import { describe, expect, test } from "bun:test";
import {
	hostedAgentDescriptorSchema,
	resolvedAgentRuntimeSchema,
} from "@wincode/ai";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import { prepareAgentCall, resolveEffectiveAgentSelection } from "./agent-call";
import {
	buildAgentRegistry,
	configuredAgentVisibleCodingTools,
} from "./registry";

const makeSnapshot = (document: Record<string, unknown>): ConfigSnapshot => ({
	diagnostics: [],
	document: document as ConfigSnapshot["document"],
	sourceFor: () => undefined,
	sources: [],
});

const hostedModel = { modelId: "gpt-5.4-mini", providerId: "wincode" } as const;
const directModel = {
	modelId: "gemini-2.5-flash",
	providerId: "google",
} as const;

describe("resolveEffectiveAgentSelection", () => {
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

		expect(
			resolveEffectiveAgentSelection(registry, "reviewer", hostedModel, "low")
		).toMatchObject({
			agent: "reviewer",
			model: { modelId: "gpt-5.5", providerId: "openai" },
			variant: "high",
		});
		expect(
			resolveEffectiveAgentSelection(registry, "plan", hostedModel, "low")
		).toMatchObject({ agent: "plan", model: hostedModel, variant: "low" });
	});

	test("falls back to Build when the selection is unavailable", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					reviewer: {
						description: "Reviews code",
						model: "openai/gpt-5.5",
						role: "primary",
					},
				},
			}),
			{ connectedProviderIds: new Set(["wincode"]) }
		);

		expect(
			resolveEffectiveAgentSelection(registry, "reviewer", hostedModel, "high")
		).toMatchObject({ agent: "build", model: hostedModel, variant: "high" });
	});
});

describe("prepareAgentCall", () => {
	test("projects the hosted descriptor with shell stripped and billing kind derived", () => {
		const registry = buildAgentRegistry(makeSnapshot({}));
		const prepared = prepareAgentCall(registry, {
			agent: "build",
			model: hostedModel,
			variant: undefined,
		});

		expect(prepared.agent).toBe("build");
		const buildAgent = registry.agents.find(({ id }) => id === "build");
		expect(prepared.resolvedAgent).toEqual({
			instructions: buildAgent?.instructions ?? "",
			visibleCodingTools: [
				"read",
				"write",
				"edit",
				"list",
				"glob",
				"grep",
				"shell",
			],
		});
		expect(prepared.hostedDescriptor).toEqual({
			billingKind: "build",
			instructions: prepared.resolvedAgent.instructions,
			mcpTools: [],
			visibleCodingTools: ["read", "write", "edit", "list", "glob", "grep"],
		});
	});

	test("derives the custom billing kind for configured Agents", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					"code-reviewer": {
						description: "Reviews diffs",
						role: "primary",
					},
				},
			})
		);
		const prepared = prepareAgentCall(registry, {
			agent: "code-reviewer",
			model: hostedModel,
			variant: undefined,
		});

		expect(prepared.agent).toBe("code-reviewer");
		expect(prepared.hostedDescriptor?.billingKind).toBe("custom");
	});

	test("omits the hosted descriptor for direct routes", () => {
		const registry = buildAgentRegistry(makeSnapshot({}));
		const prepared = prepareAgentCall(registry, {
			agent: "build",
			model: directModel,
			variant: undefined,
		});

		expect(prepared.hostedDescriptor).toBeUndefined();
		expect(prepared.resolvedAgent.visibleCodingTools).toEqual([
			"read",
			"write",
			"edit",
			"list",
			"glob",
			"grep",
			"shell",
		]);
	});

	test("falls back to Build for subagent and unknown ids", () => {
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

		const subagent = prepareAgentCall(registry, {
			agent: "issue-researcher",
			model: hostedModel,
			variant: undefined,
		});
		expect(subagent.agent).toBe("build");
		expect(subagent.resolvedAgent.instructions).toBe(
			registry.agents.find(({ id }) => id === "build")?.instructions ?? ""
		);

		const unknown = prepareAgentCall(registry, {
			agent: "does-not-exist",
			model: hostedModel,
			variant: undefined,
		});
		expect(unknown.agent).toBe("build");
	});

	test("resolves all-role agents to the selected runtime", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					"docs-writer": {
						description: "Writes docs",
						instructions: "Write documentation only.",
						role: "all",
					},
				},
			})
		);
		const prepared = prepareAgentCall(registry, {
			agent: "docs-writer",
			model: hostedModel,
			variant: undefined,
		});

		expect(prepared.agent).toBe("docs-writer");
		expect(prepared.resolvedAgent).toEqual({
			instructions: "Write documentation only.",
			visibleCodingTools: [...configuredAgentVisibleCodingTools],
		});
	});

	test("throws when no runtime can be resolved", () => {
		expect(() =>
			prepareAgentCall(null, {
				agent: "build",
				model: hostedModel,
				variant: undefined,
			})
		).toThrow("No resolved Agent or model to send");
	});

	test("pins the runtime to the schema of record on both sides of the wire", () => {
		const registry = buildAgentRegistry(
			makeSnapshot({
				agents: {
					"code-reviewer": {
						description: "Reviews diffs",
						instructions: "Review diffs.",
						role: "primary",
					},
				},
			})
		);
		const prepared = prepareAgentCall(registry, {
			agent: "code-reviewer",
			model: hostedModel,
			variant: undefined,
		});

		expect(prepared.resolvedAgent).toEqual({
			instructions: "Review diffs.",
			visibleCodingTools: [...configuredAgentVisibleCodingTools],
		});
		expect(
			resolvedAgentRuntimeSchema.safeParse(prepared.resolvedAgent).success
		).toBe(true);
		expect(
			hostedAgentDescriptorSchema.safeParse(prepared.hostedDescriptor).success
		).toBe(true);
	});
});
