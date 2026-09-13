import { describe, expect, test } from "bun:test";
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "bun";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const runnerPath = join(repositoryRoot, "scripts/test-portfolio.ts");

const output = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const runPortfolio = (
	root: string,
	portfolio: "default" | "e2e",
	extraArguments: readonly string[] = [],
	environment: Readonly<Record<string, string>> = {}
): { readonly exitCode: number; readonly output: string } => {
	const result = spawnSync(
		["bun", runnerPath, portfolio, "--root", root, ...extraArguments],
		{
			cwd: repositoryRoot,
			env: { ...process.env, ...environment },
			stderr: "pipe",
			stdout: "pipe",
		}
	);
	return {
		exitCode: result.exitCode,
		output: `${output(result.stdout)}\n${output(result.stderr)}`,
	};
};

const writeFixture = async (
	root: string,
	relativePath: string,
	contents: string
): Promise<void> => {
	const path = join(root, relativePath);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, contents);
};

const exists = async (path: string): Promise<boolean> => {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
};

describe("test portfolio runner", () => {
	test("audits placement and classification before executing Default tests", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-test-discovery-"));
		const marker = join(root, "execution.log");
		try {
			await writeFixture(
				root,
				"packages/alpha/test/default.test.ts",
				`import { appendFileSync } from "node:fs";
import { test } from "bun:test";
test("valid package test", () => {
	appendFileSync(process.env.WINCODE_PORTFOLIO_MARKER!, "default\\n");
});
`
			);
			await writeFixture(root, "packages/alpha/test/journey.e2e.test.ts", "");
			await writeFixture(
				root,
				"packages/alpha/test/provider.external.test.ts",
				""
			);
			await writeFixture(root, "packages/alpha/dist/generated.test.js", "");
			await mkdir(join(root, "packages/empty"), { recursive: true });

			const valid = runPortfolio(root, "default", [], {
				WINCODE_PORTFOLIO_MARKER: marker,
			});
			expect(valid.exitCode).toBe(0);
			expect(valid.output).toContain("Discovered Default test files: 1");
			expect(valid.output).toContain("Executed Default test files: 1");
			expect(await readFile(marker, "utf8")).toBe("default\n");

			await writeFixture(root, "packages/alpha/src/colocated.test.ts", "");
			await writeFixture(
				root,
				"packages/alpha/test/legacy.integration.test.ts",
				""
			);
			await writeFixture(root, "packages/alpha/test/unsupported.test.js", "");
			const invalid = runPortfolio(root, "default");

			expect(invalid.exitCode).not.toBe(0);
			expect(invalid.output).toContain("must live under a package-root");
			expect(invalid.output).toContain(
				"unsupported test classification suffix .integration"
			);
			expect(invalid.output).toContain("unsupported test extension .js");
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("runs Default packages sequentially and reports every package failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-default-runner-"));
		const marker = join(root, "execution.log");
		try {
			await writeFixture(
				root,
				"packages/a-fails/test/failure.test.ts",
				`import { appendFileSync } from "node:fs";
import { test, expect } from "bun:test";
test("records a package failure", () => {
	appendFileSync(process.env.WINCODE_PORTFOLIO_MARKER!, "a-fails\\n");
	expect(true).toBe(false);
});
`
			);
			await writeFixture(
				root,
				"packages/b-runs/test/after.test.ts",
				`import { appendFileSync } from "node:fs";
import { test } from "bun:test";
test("records the later package", () => {
	appendFileSync(process.env.WINCODE_PORTFOLIO_MARKER!, "b-runs\\n");
});
`
			);

			const result = runPortfolio(root, "default", [], {
				WINCODE_PORTFOLIO_MARKER: marker,
			});
			expect(result.exitCode).not.toBe(0);
			expect(result.output).toContain("Discovered Default test files: 2");
			expect(result.output).toContain("Executed Default test files: 2");
			expect(result.output).toContain("Default package failed: a-fails");
			expect(await readFile(marker, "utf8")).toBe("a-fails\nb-runs\n");
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("fails fast while retaining only the E2E log and final frame", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-e2e-runner-"));
		const marker = join(root, "journeys.log");
		try {
			await writeFixture(
				root,
				"packages/tui/test/a-fails.e2e.test.ts",
				`import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "bun:test";
const artifactDirectory = process.env.WINCODE_E2E_ARTIFACT_DIR!;
const framePath = process.env.WINCODE_E2E_FRAME_PATH!;
test("fails with an actionable frame", () => {
	appendFileSync(process.env.WINCODE_PORTFOLIO_MARKER!, "a-fails\\n");
	mkdirSync(join(artifactDirectory, "attachments"), { recursive: true });
	writeFileSync(join(artifactDirectory, "database.sqlite"), "database");
	writeFileSync(join(artifactDirectory, "environment.json"), "environment");
	writeFileSync(join(artifactDirectory, "authorization.txt"), "secret");
	writeFileSync(framePath, "final character frame");
	throw new Error("intentional E2E failure");
});
`
			);
			await writeFixture(
				root,
				"packages/tui/test/b-runs.e2e.test.ts",
				`import { appendFileSync } from "node:fs";
import { test } from "bun:test";
test("must not run after a failure", () => {
	appendFileSync(process.env.WINCODE_PORTFOLIO_MARKER!, "b-runs\\n");
});
`
			);

			const result = runPortfolio(root, "e2e", [], {
				WINCODE_PORTFOLIO_MARKER: marker,
			});
			const artifactDirectory = join(
				root,
				"test-artifacts",
				"e2e",
				"tui",
				"a-fails"
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.output).toContain("Discovered E2E test files: 2");
			expect(result.output).toContain("Executed E2E test files: 1");
			expect(await readFile(marker, "utf8")).toBe("a-fails\n");
			expect(
				await readFile(join(artifactDirectory, "runner.log"), "utf8")
			).toContain("intentional E2E failure");
			expect(
				await readFile(join(artifactDirectory, "terminal-frame.txt"), "utf8")
			).toBe("final character frame");
			expect((await readdir(artifactDirectory)).sort()).toEqual([
				"runner.log",
				"terminal-frame.txt",
			]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("removes successful artifacts and audits beyond a package filter", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-filtered-runner-"));
		const marker = join(root, "execution.log");
		try {
			await writeFixture(
				root,
				"packages/selected/test/success.e2e.test.ts",
				`import { appendFileSync } from "node:fs";
import { test } from "bun:test";
test("completes successfully", () => {
	appendFileSync(process.env.WINCODE_PORTFOLIO_MARKER!, "success\\n");
});
`
			);
			const success = runPortfolio(root, "e2e", ["--package", "selected"], {
				WINCODE_PORTFOLIO_MARKER: marker,
			});
			expect(success.exitCode).toBe(0);
			expect(success.output).toContain("Executed E2E test files: 1");
			expect(await readFile(marker, "utf8")).toBe("success\n");
			expect(await exists(join(root, "test-artifacts", "e2e"))).toBe(false);

			await writeFixture(root, "packages/other/src/forgotten.test.ts", "");
			const filtered = runPortfolio(root, "default", ["--package", "selected"]);
			expect(filtered.exitCode).not.toBe(0);
			expect(filtered.output).toContain("forgotten.test.ts");
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});
