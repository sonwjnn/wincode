import { describe, expect, test } from "bun:test";
import path from "node:path";
import { spawnSync } from "bun";

const executable = path.join(import.meta.dir, "../src/index.ts");

const run = (args: readonly string[]) =>
	spawnSync(["bun", executable, ...args], {
		stderr: "pipe",
		stdout: "pipe",
	});

const output = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("wincode executable", () => {
	test.each([
		"--help",
		"-h",
	])("%s prints root and TUI help to stdout", (flag) => {
		const result = run([flag]);
		expect(result.exitCode).toBe(0);
		expect(output(result.stdout)).toContain("Usage: wincode");
		expect(output(result.stdout)).toContain("--auto");
		expect(output(result.stderr)).toBe("");
	});

	test.each(["--version", "-v"])("%s prints the package version", (flag) => {
		const result = run([flag]);
		expect(result.exitCode).toBe(0);
		expect(output(result.stdout)).toBe("0.1.0\n");
		expect(output(result.stderr)).toBe("");
	});

	test("unknown commands are concise usage failures", () => {
		const result = run(["tui"]);
		expect(result.exitCode).toBe(2);
		expect(output(result.stdout)).toBe("");
		expect(output(result.stderr)).toBe("error: unknown command 'tui'\n");
	});

	test.each([
		"--help",
		"--version",
	])("treats %s after an unknown command as part of the usage failure", (flag) => {
		const result = run(["unknown", flag]);
		expect(result.exitCode).toBe(2);
		expect(output(result.stdout)).toBe("");
		expect(output(result.stderr)).toBe("error: unknown command 'unknown'\n");
	});

	test.each([
		{ args: ["--help", "extra"] },
		{ args: ["--version", "extra"] },
	])("rejects trailing root-control arguments", ({ args }) => {
		const result = run(args);
		expect(result.exitCode).toBe(2);
		expect(output(result.stdout)).toBe("");
		expect(output(result.stderr)).toContain("error:");
	});
});
