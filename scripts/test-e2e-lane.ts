import { Glob, spawn } from "bun";

const root = import.meta.dir.replace(/\/scripts$/, "");
const files = Array.from(
	new Glob("**/*.e2e.test.{ts,tsx}").scanSync({
		cwd: root,
		onlyFiles: true,
	})
).sort();

if (files.length === 0) {
	console.log("No E2E test files were discovered.");
	process.exit(0);
}

for (const file of files) {
	console.log(`\nRunning E2E test: ${file}`);
	const result = spawn(
		["bun", "test", "--timeout", "30000", "--no-orphans", file],
		{
			cwd: root,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		}
	);
	const exitCode = await result.exited;
	if (exitCode !== 0) {
		process.exit(exitCode);
	}
}
