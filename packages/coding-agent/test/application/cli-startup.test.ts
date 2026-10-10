import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

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
