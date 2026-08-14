import { describe, expect, test } from "bun:test";
import { formatSkillUserContext, skillActivationSchema } from "./skill-context";

describe("formatSkillUserContext", () => {
	test("wraps the body with name, source, and content hash", () => {
		const output = formatSkillUserContext({
			arguments: "focus on auth",
			contentHash: "hash-1",
			instructions: "Review code thoroughly.",
			name: "review",
			source: "explicit",
		});
		expect(output).toContain(
			'<untrusted-skill-context name="review" source="explicit" content-hash="hash-1">'
		);
		expect(output).toContain("Review code thoroughly.");
		expect(output).toContain("<arguments>focus on auth</arguments>");
		expect(output).toContain("</untrusted-skill-context>");
	});
});

describe("skillActivationSchema", () => {
	test("accepts sanitized activation metadata without instructions", () => {
		const parsed = skillActivationSchema.safeParse({
			arguments: "focus",
			contentHash: "hash-1",
			name: "review",
			source: "agent",
		});
		expect(parsed.success).toBe(true);
	});

	test("rejects rows still carrying instructions", () => {
		expect(
			skillActivationSchema.safeParse({
				arguments: "",
				contentHash: "hash-1",
				instructions: "body",
				name: "review",
				source: "explicit",
			}).success
		).toBe(false);
	});
});
