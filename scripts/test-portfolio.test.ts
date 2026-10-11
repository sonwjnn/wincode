import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isError } from "@wincode/utils";
import { spawnSync } from "bun";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const runnerPath = path.join(repositoryRoot, "scripts/test-portfolio.ts");

const output = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const isMissingPathError = (error: unknown): boolean =>
	isError(error) && "code" in error && error.code === "ENOENT";

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
	const filePath = path.join(root, relativePath);
	await fs.mkdir(path.join(filePath, ".."), { recursive: true });
	await Bun.write(filePath, contents);
};

const exists = async (filePath: string): Promise<boolean> => {
	try {
		await fs.access(filePath);
		return true;
	} catch (error) {
		if (!isMissingPathError(error)) {
			throw error;
		}
		return false;
	}
};

describe("test portfolio runner", () => {
	test("audits placement and classification before executing Default tests", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-test-discovery-")
		);
		const marker = path.join(root, "execution.log");
		try {
			await writeFixture(
				root,
				"packages/alpha/test/default.test.ts",
				`import * as fs from "node:fs";
import { expect, test } from "bun:test";
test("valid package test", () => {
	expect(process.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe("");
	expect(process.env.OPENAI_API_KEY).toBe("");
	fs.appendFileSync(process.env.WINCODE_PORTFOLIO_MARKER!, "default\\n");
});
`
			);
			await writeFixture(
				root,
				"packages/dist/test/named-package.test.ts",
				`import * as fs from "node:fs";
import { test } from "bun:test";
test("valid package named after an ignored directory", () => {
	fs.appendFileSync(process.env.WINCODE_PORTFOLIO_MARKER!, "named\\n");
});
`
			);
			await writeFixture(root, "packages/alpha/test/journey.e2e.test.ts", "");
			await writeFixture(
				root,
				"packages/alpha/test/provider.external.test.ts",
				""
			);

			const valid = runPortfolio(root, "default", [], {
				WINCODE_PORTFOLIO_MARKER: marker,
				GOOGLE_GENERATIVE_AI_API_KEY: "ambient-google",
				OPENAI_API_KEY: "ambient-openai",
			});
			expect(valid.exitCode).toBe(0);
			expect(valid.output).toContain("Discovered Default test files: 2");
			expect(valid.output).toContain("Executed Default test files: 2");
			expect(await Bun.file(marker).text()).toBe("default\nnamed\n");

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
			await fs.rm(root, { force: true, recursive: true });
		}
	});

	test("runs Default packages sequentially and reports every package failure", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-default-runner-")
		);
		const marker = path.join(root, "execution.log");
		try {
			await writeFixture(
				root,
				"packages/a-fails/test/failure.test.ts",
				`import * as fs from "node:fs";
import { test, expect } from "bun:test";
test("records a package failure", () => {
	fs.appendFileSync(process.env.WINCODE_PORTFOLIO_MARKER!, "a-fails\\n");
	expect(true).toBe(false);
});
`
			);
			await writeFixture(
				root,
				"packages/b-runs/test/after.test.ts",
				`import * as fs from "node:fs";
import { test } from "bun:test";
test("records the later package", () => {
	fs.appendFileSync(process.env.WINCODE_PORTFOLIO_MARKER!, "b-runs\\n");
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
			expect(await Bun.file(marker).text()).toBe("a-fails\nb-runs\n");
		} finally {
			await fs.rm(root, { force: true, recursive: true });
		}
	});

	test("fails fast while retaining only the E2E log and final frame", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-e2e-runner-")
		);
		const marker = path.join(root, "journeys.log");
		try {
			await writeFixture(
				root,
				"packages/coding-agent/test/a-fails.e2e.test.ts",
				`import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "bun:test";
const artifactDirectory = process.env.WINCODE_E2E_ARTIFACT_DIR!;
const framePath = process.env.WINCODE_E2E_FRAME_PATH!;
test("fails with an actionable frame", () => {
	fs.appendFileSync(process.env.WINCODE_PORTFOLIO_MARKER!, "a-fails\\n");
	fs.mkdirSync(path.join(artifactDirectory, "attachments"), { recursive: true });
	fs.writeFileSync(path.join(artifactDirectory, "database.sqlite"), "database");
	fs.writeFileSync(path.join(artifactDirectory, "environment.json"), "environment");
	fs.writeFileSync(path.join(artifactDirectory, "authorization.txt"), "secret");
	fs.writeFileSync(path.join(artifactDirectory, "constructor"), "sensitive");
	fs.writeFileSync(framePath, "final character frame");
	throw new Error("intentional E2E failure");
});
`
			);
			await writeFixture(
				root,
				"packages/coding-agent/test/b-runs.e2e.test.ts",
				`import * as fs from "node:fs";
import { test } from "bun:test";
test("must not run after a failure", () => {
	fs.appendFileSync(process.env.WINCODE_PORTFOLIO_MARKER!, "b-runs\\n");
});
`
			);

			const result = runPortfolio(root, "e2e", [], {
				WINCODE_PORTFOLIO_MARKER: marker,
			});
			const artifactDirectory = path.join(
				root,
				"test-artifacts",
				"e2e",
				"coding-agent",
				"a-fails"
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.output).toContain("Discovered E2E test files: 2");
			expect(result.output).toContain("Executed E2E test files: 1");
			expect(await Bun.file(marker).text()).toBe("a-fails\n");
			expect(
				await Bun.file(path.join(artifactDirectory, "runner.log")).text()
			).toContain("intentional E2E failure");
			expect(
				await Bun.file(
					path.join(artifactDirectory, "terminal-frame.txt")
				).text()
			).toBe("final character frame");
			expect((await fs.readdir(artifactDirectory)).sort()).toEqual([
				"runner.log",
				"terminal-frame.txt",
			]);
		} finally {
			await fs.rm(root, { force: true, recursive: true });
		}
	});

	test("keeps dotted E2E filenames in isolated artifact directories", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-e2e-scenario-")
		);
		try {
			await writeFixture(
				root,
				"packages/coding-agent/test/...e2e.test.ts",
				`import * as fs from "node:fs";
import { test } from "bun:test";
const framePath = process.env.WINCODE_E2E_FRAME_PATH!;
test("fails after writing the final frame", () => {
	fs.writeFileSync(framePath, "safe frame");
	throw new Error("dotted scenario failure");
});
`
			);

			const result = runPortfolio(root, "e2e");
			const artifactDirectory = path.join(
				root,
				"test-artifacts",
				"e2e",
				"coding-agent",
				"-"
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.output).toContain("Executed E2E test files: 1");
			expect(await exists(path.join(artifactDirectory, "runner.log"))).toBe(
				true
			);
			expect(
				await Bun.file(
					path.join(artifactDirectory, "terminal-frame.txt")
				).text()
			).toBe("safe frame");
			expect(
				await exists(
					path.join(root, "test-artifacts", "e2e", "terminal-frame.txt")
				)
			).toBe(false);
		} finally {
			await fs.rm(root, { force: true, recursive: true });
		}
	});
	test("removes successful artifacts and audits beyond a package filter", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-filtered-runner-")
		);
		const marker = path.join(root, "execution.log");
		try {
			await writeFixture(
				root,
				"packages/selected/test/success.e2e.test.ts",
				`import * as fs from "node:fs";
import { test } from "bun:test";
test("completes successfully", () => {
	fs.appendFileSync(process.env.WINCODE_PORTFOLIO_MARKER!, "success\\n");
});
`
			);
			const success = runPortfolio(root, "e2e", ["--package", "selected"], {
				WINCODE_PORTFOLIO_MARKER: marker,
			});
			expect(success.exitCode).toBe(0);
			expect(success.output).toContain("Executed E2E test files: 1");
			expect(await Bun.file(marker).text()).toBe("success\n");
			expect(await exists(path.join(root, "test-artifacts", "e2e"))).toBe(
				false
			);

			await writeFixture(root, "packages/other/src/forgotten.test.ts", "");
			const filtered = runPortfolio(root, "default", ["--package", "selected"]);
			expect(filtered.exitCode).not.toBe(0);
			expect(filtered.output).toContain("forgotten.test.ts");
		} finally {
			await fs.rm(root, { force: true, recursive: true });
		}
	});
});
