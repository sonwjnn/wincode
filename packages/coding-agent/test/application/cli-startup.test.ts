import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createTestRenderer } from "@opentui/core/testing";
import { createModeRunnerLoader } from "../../bin/mode-runners";
import type { DispatchModeRunners } from "../../modules/application/dispatch";
import { dispatch } from "../../modules/application/dispatch";
import { getInteractiveRuntimeContext } from "../../shared/runtime-context";

test("interactive runner restores runtime context before opening the TUI", async () => {
	const setup = await createTestRenderer({ height: 24, width: 80 });
	let observed: { args: readonly string[]; cwd: string } | undefined;
	const runners = await createModeRunnerLoader({
		promptProjectTrust: async () => "trust",
		rendererFactory: async () => setup.renderer,
		runInteractive: async () => {
			const context = getInteractiveRuntimeContext();
			observed = { args: context.args, cwd: context.cwd };
			return 0;
		},
	})("interactive");

	try {
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
	} finally {
		await runners.cleanup?.();
	}
});

test("interactive startup diagnostics stay in the TUI while print diagnostics stay on stderr", async () => {
	let interactiveDiagnostics: readonly string[] | undefined;
	const runners: DispatchModeRunners = {
		interactive: async (context) => {
			interactiveDiagnostics = context.startupDiagnostics;
			return 0;
		},
		json: async () => 0,
		print: async () => 0,
		rpc: async () => 0,
	};
	let interactiveStderr = "";
	const initializeRuntime = async () => ({
		startupDiagnostics: ["project resources were omitted"],
	});
	await dispatch(
		{
			args: [],
			cwd: "/workspace/project",
			stderr: { write: (text) => (interactiveStderr += text) },
			stdinIsTTY: true,
			stdout: { write: () => undefined },
		},
		runners,
		{ initializeRuntime }
	);
	let printStderr = "";
	await dispatch(
		{
			args: ["--mode", "print"],
			cwd: "/workspace/project",
			stderr: { write: (text) => (printStderr += text) },
			stdinIsTTY: false,
			stdout: { write: () => undefined },
		},
		runners,
		{ initializeRuntime }
	);

	expect(interactiveStderr).toBe("");
	expect(interactiveDiagnostics).toEqual(["project resources were omitted"]);
	expect(printStderr).toContain(
		"Project trust: project resources were omitted"
	);
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
