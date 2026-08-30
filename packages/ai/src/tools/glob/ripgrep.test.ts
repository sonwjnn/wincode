import { describe, expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { GlobSearchInput } from "./backend";
import { buildRipgrepGlobArguments, runRipgrepGlob } from "./ripgrep";

type FakeChild = EventEmitter & {
	killed: boolean;
	stderr: PassThrough;
	stdout: PassThrough;
	kill: () => boolean;
};

const createFakeChild = (): FakeChild => {
	const child = new EventEmitter() as FakeChild;
	child.killed = false;
	child.stderr = new PassThrough();
	child.stdout = new PassThrough();
	child.kill = () => {
		child.killed = true;
		child.stdout.end();
		child.stderr.end();
		queueMicrotask(() => child.emit("close", null));
		return true;
	};
	return child;
};

const input: GlobSearchInput = {
	cwd: "/workspace",
	gitignore: true,
	hidden: false,
	maxCandidates: 10_000,
	maxDurationMs: 5000,
	path: "src",
	pattern: "*.ts",
};

describe("ripgrep glob adapter", () => {
	test("passes glob controls and hard-prunes .git", () => {
		const args = buildRipgrepGlobArguments(input);
		const separator = args.indexOf("--");

		expect(separator).toBeGreaterThan(-1);
		expect(args.slice(separator)).toEqual(["--", "src"]);
		expect(args).toContain("--files");
		expect(args).toContain("--null");
		expect(args).toContain("*.ts");
		expect(args).toContain("!**/.git/**");
		expect(args).toContain("!**/.git");
		expect(args).toContain("!**/node_modules/**");
		expect(args).not.toContain("--hidden");
		expect(args).not.toContain("--no-ignore");

		const optedIn = buildRipgrepGlobArguments({
			...input,
			gitignore: false,
			hidden: true,
		});
		expect(optedIn).toContain("--hidden");
		expect(optedIn).toContain("--no-ignore");
	});

	test("reports candidate-bound truncation", async () => {
		const child = createFakeChild();
		const run = runRipgrepGlob(
			{ ...input, maxCandidates: 2 },
			{
				resolveExecutable: async () => "/rg",
				spawnProcess: (() => {
					queueMicrotask(() => child.stdout.write("a.ts\0b.ts\0"));
					return child;
				}) as unknown as typeof spawn,
			}
		);

		await expect(run).resolves.toEqual({
			paths: ["a.ts", "b.ts"],
			truncated: true,
		});
	});

	test("fails clearly when ripgrep exceeds its deadline", async () => {
		const child = createFakeChild();
		await expect(
			runRipgrepGlob(
				{ ...input, maxDurationMs: 10 },
				{
					spawnProcess: (() => child) as unknown as typeof spawn,
				}
			)
		).rejects.toThrow("ripgrep glob search timed out after 10ms.");
		expect(child.killed).toBe(true);
	});
});
