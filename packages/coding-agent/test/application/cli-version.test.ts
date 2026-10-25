import { expect, test } from "bun:test";
import { dispatch } from "../../modules/application/dispatch";
import { APP_VERSION } from "../../shared/app-info";

test("CLI version comes from embedded package metadata without initializing runtime", async () => {
	let stdout = "";
	let stderr = "";
	const exitCode = await dispatch(
		{
			args: ["--version"],
			cwd: "/workspace/project",
			stderr: { write: (text) => (stderr += text) },
			stdinIsTTY: false,
			stdout: { write: (text) => (stdout += text) },
		},
		undefined
	);

	expect(exitCode).toBe(0);
	expect(stdout).toBe(`${APP_VERSION}\n`);
	expect(stderr).toBe("");
});
