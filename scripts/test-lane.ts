import { Glob, spawn } from "bun";

const root = import.meta.dir.replace(/\/scripts$/, "");
const files = Array.from(
	new Glob("**/*.integration.test.{ts,tsx}").scanSync({
		cwd: root,
		onlyFiles: true,
	})
).sort();

if (files.length === 0) {
	console.log("No integration test files were discovered.");
	process.exit(0);
}

const command = ["bun", "test", "--timeout", "30000", "--no-orphans", ...files];

const result = spawn(command, {
	cwd: root,
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
});

process.exit(await result.exited);
