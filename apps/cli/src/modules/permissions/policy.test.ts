import { describe, expect, test } from "bun:test";
import {
	createToolPermission,
	DEFAULT_READ_PERMISSION_RULES,
	matchesResourcePattern,
} from "./policy";

describe("matchesResourcePattern", () => {
	test("matches exact and glob patterns at the workspace root", () => {
		expect(matchesResourcePattern(".env", ".env")).toBe(true);
		expect(matchesResourcePattern(".env.example", ".env.example")).toBe(true);
		expect(matchesResourcePattern(".env.*", ".env.production")).toBe(true);
		expect(matchesResourcePattern("*.env", "local.env")).toBe(true);
		expect(matchesResourcePattern("local.env", ".env")).toBe(false);
	});

	test("bare patterns match below any directory prefix", () => {
		expect(matchesResourcePattern(".env", "apps/api/.env")).toBe(true);
		expect(matchesResourcePattern(".env.*", "apps/api/.env.local")).toBe(true);
		expect(
			matchesResourcePattern(".env.example", "apps/api/.env.example")
		).toBe(true);
		expect(matchesResourcePattern("*.json", "apps/api/package.json")).toBe(
			true
		);
	});

	test("path patterns only match the full relative path", () => {
		expect(matchesResourcePattern("apps/api/*.ts", "apps/api/route.ts")).toBe(
			true
		);
		expect(matchesResourcePattern("apps/api/*.ts", "apps/route.ts")).toBe(
			false
		);
		expect(matchesResourcePattern("**/.env", "apps/api/.env")).toBe(true);
		expect(matchesResourcePattern("**/.env", ".env")).toBe(true);
	});

	test("? matches a single non-slash character", () => {
		expect(matchesResourcePattern("file?.txt", "file1.txt")).toBe(true);
		expect(matchesResourcePattern("file?.txt", "file12.txt")).toBe(false);
	});
});

describe("createToolPermission defaults", () => {
	const permission = createToolPermission();

	test("seeds .env and .env.* reads as ask", () => {
		expect(DEFAULT_READ_PERMISSION_RULES[".env"]).toBe("ask");
		expect(DEFAULT_READ_PERMISSION_RULES[".env.*"]).toBe("ask");
		expect(permission.decide("read", ".env")).toBe("ask");
		expect(permission.decide("read", ".env.production")).toBe("ask");
		expect(permission.decide("read", "apps/api/.env")).toBe("ask");
		expect(permission.decide("read", "apps/api/.env.local")).toBe("ask");
	});

	test("seeds .env.example and ordinary reads as allow", () => {
		expect(DEFAULT_READ_PERMISSION_RULES[".env.example"]).toBe("allow");
		expect(permission.decide("read", ".env.example")).toBe("allow");
		expect(permission.decide("read", "apps/api/.env.example")).toBe("allow");
		expect(permission.decide("read", "package.json")).toBe("allow");
		expect(permission.decide("read", "src/app.ts")).toBe("allow");
	});

	test("allows every action by default", () => {
		for (const action of ["write", "edit", "list", "grep"] as const) {
			expect(permission.decide(action, "anything")).toBe("allow");
		}
	});
});

describe("createToolPermission configured rules", () => {
	test("a configured read map layers over the defaults", () => {
		const permission = createToolPermission({
			read: { ".env": "deny" },
		});
		expect(permission.decide("read", ".env")).toBe("deny");
		expect(permission.decide("read", ".env.local")).toBe("ask");
		expect(permission.decide("read", ".env.example")).toBe("allow");
		expect(permission.decide("read", "package.json")).toBe("allow");
	});

	test("an unrelated configured action retains the read defaults", () => {
		const permission = createToolPermission({ write: "deny" });
		expect(permission.decide("read", ".env.local")).toBe("ask");
	});

	test("a scalar action applies to every resource", () => {
		const permission = createToolPermission({ read: "ask" });
		expect(permission.decide("read", ".env")).toBe("ask");
		expect(permission.decide("read", "package.json")).toBe("ask");
	});

	test("the last matching rule wins", () => {
		const permission = createToolPermission({
			read: { ".env": "ask", "**": "allow" },
		});
		expect(permission.decide("read", ".env")).toBe("allow");
	});

	test("unmatched resources fall back to allow", () => {
		const permission = createToolPermission({
			read: { "src/*": "ask" },
		});
		expect(permission.decide("read", "src/app.ts")).toBe("ask");
		expect(permission.decide("read", "lib/app.ts")).toBe("allow");
	});

	test("unknown action keys stay inert", () => {
		const permission = createToolPermission({
			read: "allow",
			future: "deny",
		} as unknown as Parameters<typeof createToolPermission>[0]);
		expect(permission.decide("read", "x")).toBe("allow");
	});
});
