import { describe, expect, test } from "bun:test";
import { resolveSubmissionPrompt } from "@/modules/commands/submission-resolution";
import type { Skill } from "@/modules/skills";

const REVIEW_SKILL: Skill = {
	body: "Review changes.",
	description: "Review changes",
	filePath: "/tmp/review/SKILL.md",
	name: "review",
	scope: "project",
};

const AUDIT_SKILL: Skill = {
	body: "Audit dependencies.",
	description: "Audit dependencies",
	filePath: "/tmp/audit/SKILL.md",
	name: "audit",
	scope: "project",
};

describe("resolveSubmissionPrompt", () => {
	test("strips every selected marker regardless of intent order", async () => {
		const text = "please /skill:audit and /skill:review now";
		const resolution = await resolveSubmissionPrompt({
			discoverCustomCommands: async () => [],
			discoverSkills: async () => [REVIEW_SKILL, AUDIT_SKILL],
			intents: [
				// Deliberately out of prompt order: callers are not required to sort.
				{
					end: 37,
					kind: "skill",
					marker: "/skill:review",
					name: "review",
					start: 24,
				},
				{
					end: 19,
					kind: "skill",
					marker: "/skill:audit",
					name: "audit",
					start: 7,
				},
			],
			text,
		});

		expect(resolution).toEqual({
			kind: "ready",
			skill: { instructions: AUDIT_SKILL.body, name: "audit" },
			text: "please and now",
		});
	});
});
