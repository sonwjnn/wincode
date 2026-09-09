import { Glob, spawn } from "bun";

type Lane = "integration" | "postgres";

const lane = process.argv[2] as Lane | undefined;
const patterns: Record<Lane, string> = {
	integration: "**/*.integration.test.{ts,tsx}",
	postgres: "**/*.postgres.test.{ts,tsx}",
};

if (!(lane && lane in patterns)) {
	throw new Error("Usage: bun scripts/test-lane.ts <integration|postgres>");
}
if (lane === "postgres" && !process.env.DATABASE_URL) {
	throw new Error(
		"PostgreSQL integration requires DATABASE_URL; start an isolated service and opt in explicitly."
	);
}

const root = import.meta.dir.replace(/\/scripts$/, "");
const files = Array.from(
	new Glob(patterns[lane]).scanSync({ cwd: root, onlyFiles: true })
).sort();
if (files.length === 0) {
	console.log(
		`No ${lane} test files were discovered; lane is ready for future coverage.`
	);
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
