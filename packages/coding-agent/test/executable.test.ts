import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "bun";

const executable = path.join(import.meta.dir, "../cli/executable.ts");
const executableTestRoot = mkdtempSync(
	path.join(tmpdir(), "wincode-executable-")
);
const sessionDatabasePath = path.join(executableTestRoot, "sessions.db");
const executableEnvironment = {
	...process.env,
	HOME: path.join(executableTestRoot, "home"),
	WINCODE_LOCAL_DB_PATH: sessionDatabasePath,
	XDG_CONFIG_HOME: path.join(executableTestRoot, "config"),
};

const run = (args: readonly string[], input?: string) =>
	spawnSync(["bun", executable, ...args], {
		cwd: executableTestRoot,
		env: executableEnvironment,
		stderr: "pipe",
		stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
		stdout: "pipe",
	});

const output = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("wincode executable", () => {
	test.each([
		"--help",
		"-h",
	])("%s prints root help to stdout without launching a mode", (flag) => {
		const result = run([flag]);
		expect(result.exitCode).toBe(0);
		expect(output(result.stdout)).toContain("Usage: wincode");
		expect(output(result.stdout)).toContain("-m, --mode");
		expect(output(result.stdout)).toContain("--auto");
		expect(output(result.stderr)).toBe("");
	});

	test("mode rpc emits only protocol frames and preserves planned shutdown status", () => {
		const result = run(
			["--mode", "rpc"],
			`${JSON.stringify({
				id: "shutdown-1",
				jsonrpc: "2.0",
				method: "server/shutdown",
				params: {},
			})}\n`
		);
		expect(result.exitCode).toBe(0);
		expect(output(result.stdout)).toBe(
			'{"id":"shutdown-1","jsonrpc":"2.0","result":{"shutdown":true}}\n'
		);
		expect(output(result.stderr)).toBe("");
	});

	test("mode rpc completes an initialize and shutdown journey", () => {
		const result = run(
			["--mode", "rpc"],
			`${[
				JSON.stringify({
					id: "initialize-1",
					jsonrpc: "2.0",
					method: "initialize",
					params: {
						capabilities: {},
						clientInfo: { name: "executable-smoke" },
						cwd: executableTestRoot,
						protocolVersion: 1,
					},
				}),
				JSON.stringify({
					id: "shutdown-1",
					jsonrpc: "2.0",
					method: "server/shutdown",
					params: {},
				}),
			].join("\n")}\n`
		);
		const frames = output(result.stdout)
			.trim()
			.split("\n")
			.map((frame) => JSON.parse(frame) as Record<string, unknown>);

		expect(result.exitCode).toBe(0);
		expect(output(result.stderr)).toBe("");
		expect(frames).toHaveLength(2);
		expect(frames[0]).toMatchObject({
			id: "initialize-1",
			jsonrpc: "2.0",
			result: {
				capabilities: {
					approvalResponses: true,
					stateNotifications: true,
					submissionEvents: true,
					transcriptPagination: true,
				},
				protocolVersion: 1,
			},
		});
		expect(frames[1]).toEqual({
			id: "shutdown-1",
			jsonrpc: "2.0",
			result: { shutdown: true },
		});
	});

	test.each(["--version", "-v"])("%s prints the package version", (flag) => {
		const result = run([flag]);
		expect(result.exitCode).toBe(0);
		expect(output(result.stdout)).toBe("0.1.0\n");
		expect(output(result.stderr)).toBe("");
	});

	test("the removed rpc command is a concise usage failure", () => {
		const result = run(["rpc"]);
		expect(result.exitCode).toBe(2);
		expect(output(result.stdout)).toBe("");
		expect(output(result.stderr)).toBe("error: unknown command 'rpc'.\n");
	});

	test("JSON mode reports parser failures as JSONL", () => {
		const result = run(["--mode", "json", "--bogus"]);
		expect(result.exitCode).toBe(2);
		expect(output(result.stdout)).toBe(
			`${JSON.stringify({ error: "unknown option '--bogus'." })}\n`
		);
		expect(output(result.stderr)).toBe("error: unknown option '--bogus'.\n");
	});

	test("unknown commands are concise usage failures", () => {
		const result = run(["tui"]);
		expect(result.exitCode).toBe(2);
		expect(output(result.stdout)).toBe("");
		expect(output(result.stderr)).toBe("error: unknown command 'tui'.\n");
	});

	test.each([
		"--help",
		"--version",
	])("treats %s after an unknown command as part of the usage failure", (flag) => {
		const result = run(["unknown", flag]);
		expect(result.exitCode).toBe(2);
		expect(output(result.stdout)).toBe("");
		expect(output(result.stderr)).toBe("error: unknown command 'unknown'.\n");
	});

	test.each([
		"--help",
		"--version",
	])("rejects trailing root-control arguments", (flag) => {
		const result = run([flag, "extra"]);
		expect(result.exitCode).toBe(2);
		expect(output(result.stdout)).toBe("");
		expect(output(result.stderr)).toContain("error:");
	});
});
