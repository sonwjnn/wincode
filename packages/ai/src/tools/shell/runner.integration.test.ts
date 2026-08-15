import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
	buildShellInvocation,
	composeShellTimeoutMessage,
	createShellRunner,
	decodeShellOutput,
	runShellTool,
	SHELL_OUTPUT_TRUNCATION_BANNER,
	type ShellInvocation,
} from "./runner";

const workspace = process.cwd();

let tempPaths: string[] = [];

const makeTempDir = (): string => {
	// macOS tempdirs live behind a /var -> /private/var symlink; realpath keeps
	// the expectation aligned with what `pwd` reports.
	const dir = realpathSync(
		mkdtempSync(path.join(tmpdir(), "wincode-shell-test-"))
	);
	tempPaths.push(dir);
	return dir;
};

afterEach(() => {
	for (const dir of tempPaths) {
		rmSync(dir, { force: true, recursive: true });
	}
	tempPaths = [];
});

describe("buildShellInvocation", () => {
	test("composes a POSIX /bin/bash -c invocation", () => {
		expect(buildShellInvocation("echo hi", "posix")).toEqual({
			args: ["-c", "echo hi"],
			decodeUtf16Le: false,
			executable: "/bin/bash",
		} satisfies ShellInvocation);
	});

	test("composes a win32 powershell.exe -Command invocation", () => {
		expect(buildShellInvocation("Write-Output hi", "win32")).toEqual({
			args: ["-NoProfile", "-NonInteractive", "-Command", "Write-Output hi"],
			decodeUtf16Le: true,
			executable: "powershell.exe",
		} satisfies ShellInvocation);
	});
});

describe("decodeShellOutput", () => {
	test("decodes UTF-16LE when a BOM is present and expected", () => {
		const buffer = Buffer.concat([
			Buffer.from([0xff, 0xfe]),
			Buffer.from("hello", "utf16le"),
		]);
		expect(decodeShellOutput(buffer, true)).toBe("hello");
	});

	test("falls back to UTF-8 without a BOM", () => {
		expect(decodeShellOutput(Buffer.from("hello", "utf8"), true)).toBe("hello");
		expect(decodeShellOutput(Buffer.from("hello", "utf8"), false)).toBe(
			"hello"
		);
	});
});

describe("runShellTool", () => {
	test("executes a command and merges stdout and stderr", async () => {
		const result = await runShellTool({
			command: "printf 'out\\n'; printf 'err\\n' >&2; exit 3",
		});
		expect(result.exitCode).toBe(3);
		expect(result.output).toContain("out");
		expect(result.output).toContain("err");
		expect(result.timedOut).toBeUndefined();
		expect(result.truncated).toBeUndefined();
	});

	test("inherits the parent environment", async () => {
		const previous = process.env.WINCODE_SHELL_TEST;
		process.env.WINCODE_SHELL_TEST = "inherited-value";
		try {
			const result = await runShellTool({
				command: "echo $WINCODE_SHELL_TEST",
			});
			expect(result.output).toContain("inherited-value");
		} finally {
			if (previous === undefined) {
				delete process.env.WINCODE_SHELL_TEST;
			} else {
				process.env.WINCODE_SHELL_TEST = previous;
			}
		}
	});

	test("runs at the workspace root by default", async () => {
		const result = await runShellTool({ command: "pwd" });
		expect(result.output.trim()).toBe(workspace);
	});

	test("runs in a workspace-internal cwd", async () => {
		const dir = makeTempDir();
		const relative = path.relative(workspace, dir);
		const result = await runShellTool({ command: "pwd", cwd: relative });
		expect(result.output.trim()).toBe(dir);
	});

	test("runs in an external cwd verbatim", async () => {
		const dir = makeTempDir();
		const result = await runShellTool({ command: "pwd", cwd: dir });
		expect(result.output.trim()).toBe(dir);
	});

	test("expands ~ in an external cwd", async () => {
		const homeTarget = path.join(
			homedir(),
			"wincode-nonexistent-shell-test-dir"
		);
		mkdirSync(homeTarget, { recursive: true });
		tempPaths.push(homeTarget);
		const result = await runShellTool({
			command: "pwd",
			cwd: "~/wincode-nonexistent-shell-test-dir",
		});
		expect(result.output.trim()).toBe(homeTarget);
	});

	test("fails fast on commands that wait for stdin", async () => {
		const startedAt = Date.now();
		const result = await runShellTool({ command: "cat", timeout: 5 });
		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("");
		expect(Date.now() - startedAt).toBeLessThan(3000);
	});

	test("kills the process tree at the timeout with a model-visible note", async () => {
		const startedAt = Date.now();
		const result = await runShellTool({ command: "sleep 30", timeout: 1 });
		expect(result.timedOut).toBe(true);
		expect(result.exitCode).toBeNull();
		expect(result.output).toContain(composeShellTimeoutMessage(1));
		expect(Date.now() - startedAt).toBeLessThan(10_000);
	});

	test("keeps the output tail at 30 KiB with a truncation banner", async () => {
		const result = await runShellTool({ command: "seq 1 100000" });
		expect(result.truncated).toBe(true);
		expect(result.output).toContain(SHELL_OUTPUT_TRUNCATION_BANNER);
		const tail = result.output.slice(SHELL_OUTPUT_TRUNCATION_BANNER.length);
		expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(30 * 1024);
		expect(result.output).toContain("100000");
		expect(result.output).not.toContain("1\n2\n3\n");
	});

	test("kills background processes whose output escapes the captured pipes", async () => {
		const dir = makeTempDir();
		const marker = path.join(dir, "marker.txt");
		// The background subshell redirects its output away from the captured
		// pipes, so the shell exits immediately and the runner must terminate
		// the surviving descendant when the tool call ends.
		const result = await runShellTool({
			command: `(sleep 1; touch '${marker}') > /dev/null 2>&1 &`,
		});
		expect(result.exitCode).toBe(0);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		expect(existsSync(marker)).toBe(false);
	});

	test("settles promptly when a background child keeps the pipes open", async () => {
		// The main shell exits immediately, but the background child holds the
		// captured pipes open; the runner must drain and settle instead of
		// waiting for the timeout and misreporting the completed command.
		const startedAt = Date.now();
		const result = await runShellTool({
			command: "(sleep 30) & echo done",
			timeout: 5,
		});
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("done");
		expect(result.timedOut).toBeUndefined();
		expect(Date.now() - startedAt).toBeLessThan(3000);
	});

	test("delegates the platform branch to the injected builder", async () => {
		const calls: Array<{ command: string; platform: string }> = [];
		const runner = createShellRunner({
			buildInvocation: (command, platform) => {
				calls.push({ command, platform });
				return buildShellInvocation(command, "posix");
			},
			platform: "win32",
		});
		const result = await runner({ command: "echo injected" });
		expect(calls).toEqual([{ command: "echo injected", platform: "win32" }]);
		expect(result.output).toContain("injected");
	});

	test("rejects when the cwd does not exist", async () => {
		const dir = path.join(tmpdir(), "wincode-shell-missing-cwd");
		rmSync(dir, { force: true, recursive: true });
		await expect(runShellTool({ command: "pwd", cwd: dir })).rejects.toThrow();
	});
});
