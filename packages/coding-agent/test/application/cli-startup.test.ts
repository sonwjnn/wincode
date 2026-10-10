import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createModeRunnerLoader } from "../../bin/mode-runners";
import { getInteractiveRuntimeContext } from "../../shared/runtime-context";

test("interactive runner restores runtime context before opening the TUI", async () => {
	let observed: { args: readonly string[]; cwd: string } | undefined;
	const runners = await createModeRunnerLoader({
		promptProjectTrust: async () => "trust",
		runInteractive: async () => {
			const context = getInteractiveRuntimeContext();
			observed = { args: context.args, cwd: context.cwd };
			return 0;
		},
	})("interactive");

	await runners.interactive({
		args: ["--mode", "interactive"],
		cwd: "/workspace/project",
		invocation: { mode: "interactive" },
		stderr: { write: () => undefined },
		stdinIsTTY: true,
		stdout: { write: () => undefined },
	});

	expect(observed).toEqual({
		args: ["--mode", "interactive"],
		cwd: "/workspace/project",
	});
});

test("interactive entrypoint statically loads before runtime context is initialized", async () => {
	const cli = Bun.spawn(
		[
			process.execPath,
			"run",
			fileURLToPath(
				new URL("../../bin/wincode-interactive.ts", import.meta.url)
			),
			"--help",
		],
		{ stderr: "pipe", stdout: "pipe" }
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(cli.stdout).text(),
		new Response(cli.stderr).text(),
		cli.exited,
	]);

	expect(exitCode).toBe(0);
	expect(stdout).toContain("Usage: wincode [options]");
	expect(stderr).toBe("");
});

test("CLI help remains available before an interactive runtime is initialized", async () => {
	const cli = Bun.spawn(
		[
			process.execPath,
			"run",
			fileURLToPath(new URL("../../bin/wincode.ts", import.meta.url)),
			"--help",
		],
		{ stderr: "pipe", stdout: "pipe" }
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(cli.stdout).text(),
		new Response(cli.stderr).text(),
		cli.exited,
	]);

	expect(exitCode).toBe(0);
	expect(stdout).toContain("Usage: wincode [options]");
	expect(stderr).toBe("");
});
