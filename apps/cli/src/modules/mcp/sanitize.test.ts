import { describe, expect, test } from "bun:test";
import type { ResolvedMcpServerConfig } from "./config";
import { collectSecrets, sanitizeMessage } from "./sanitize";

const localConfig = (): ResolvedMcpServerConfig => ({
	name: "demo",
	type: "local",
	command: ["bun", "x", "demo"],
	disabled: false,
	permission: "ask",
	timeout: { startup: 30_000, catalog: 30_000, execution: 43_200_000 },
	environment: { API_KEY: "env-super-secret" },
});

const remoteConfig = (): ResolvedMcpServerConfig => ({
	name: "remote-demo",
	type: "remote",
	url: "https://secret-host.example/mcp",
	disabled: false,
	permission: "ask",
	timeout: { startup: 30_000, catalog: 30_000, execution: 43_200_000 },
	headers: { Authorization: "Bearer super-secret-token" },
});

describe("mcp sanitize", () => {
	test("collectSecrets returns environment values for local servers", () => {
		expect(collectSecrets(localConfig())).toEqual([
			"x",
			"demo",
			"env-super-secret",
		]);
	});

	test("collectSecrets returns headers and url for remote servers", () => {
		expect(collectSecrets(remoteConfig())).toEqual([
			"Bearer super-secret-token",
			"https://secret-host.example/mcp",
		]);
	});

	test("sanitizeMessage redacts local environment secrets", () => {
		const message = sanitizeMessage(
			localConfig(),
			new Error("boom env-super-secret"),
			"fallback"
		);
		expect(message).toBe("boom [redacted]");
	});

	test("sanitizeMessage redacts remote headers and url", () => {
		const message = sanitizeMessage(
			remoteConfig(),
			new Error(
				"auth failed at https://secret-host.example/mcp with Bearer super-secret-token"
			),
			"fallback"
		);
		expect(message).not.toContain("super-secret-token");
		expect(message).not.toContain("secret-host.example");
		expect(message).not.toContain("Bearer");
	});

	test("sanitizeMessage uses the fallback when config is undefined", () => {
		expect(sanitizeMessage(undefined, new Error("raw error"), "fallback")).toBe(
			"fallback"
		);
	});

	test("sanitizeMessage strips controls, generic secrets, and oversized tails", () => {
		const message = sanitizeMessage(
			localConfig(),
			new Error(
				`boom\nAuthorization: Bearer generic-secret ${"x".repeat(4096)}TAIL`
			),
			"fallback"
		);

		expect(message).toContain("boom [redacted]");
		expect(message).not.toContain("generic-secret");
		expect(message).not.toContain("boom\n");
		expect(message).not.toContain("TAIL");
		expect(message.length).toBeLessThanOrEqual(2048);
	});

	test("sanitizeMessage falls back to the given fallback for non-errors", () => {
		expect(
			sanitizeMessage(localConfig(), "not an error", "unknown MCP error")
		).toBe("unknown MCP error");
	});
});
