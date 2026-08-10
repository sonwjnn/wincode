import { describe, expect, test } from "bun:test";
import { resolveApproval } from "./approval-resolution";

const never = () => false;
const always = () => true;

const base = {
	action: "edit" as const,
	resource: "src/app.ts",
	isGranted: never,
	isAutoApproval: never,
};

describe("resolveApproval", () => {
	test("passes an allow through", () => {
		expect(resolveApproval({ ...base, decision: "allow", safety: false })).toBe(
			"allow"
		);
	});

	test("always preserves an explicit deny", () => {
		expect(
			resolveApproval({
				...base,
				decision: "deny",
				safety: false,
				isGranted: always,
				isAutoApproval: always,
			})
		).toBe("deny");
	});

	test("an ordinary ask is satisfied by an exact grant", () => {
		expect(
			resolveApproval({
				...base,
				decision: "ask",
				safety: false,
				isGranted: (action, resource) =>
					action === "edit" && resource === "src/app.ts",
			})
		).toBe("allow");
	});

	test("an ordinary ask is satisfied by auto approval", () => {
		expect(
			resolveApproval({
				...base,
				decision: "ask",
				safety: false,
				isAutoApproval: always,
			})
		).toBe("allow");
	});

	test("an ordinary ask with no grant or auto stays ask", () => {
		expect(resolveApproval({ ...base, decision: "ask", safety: false })).toBe(
			"ask"
		);
	});

	test("a safety ask cannot be bypassed by a grant", () => {
		expect(
			resolveApproval({
				...base,
				decision: "ask",
				safety: true,
				isGranted: always,
			})
		).toBe("ask");
	});

	test("a safety ask cannot be bypassed by auto approval", () => {
		expect(
			resolveApproval({
				...base,
				decision: "ask",
				safety: true,
				isAutoApproval: always,
			})
		).toBe("ask");
	});
});
