import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import {
	type DiscoveredTestFile,
	discoverTests,
	testsForClassification,
} from "../test-discovery";

/** Shared plumbing for the test-curation harness. */

export const repoRoot = (): string => path.resolve(import.meta.dir, "../..");

export const artifactsRoot = (): string =>
	process.env.CURATION_ARTIFACTS === undefined ||
	process.env.CURATION_ARTIFACTS.length === 0
		? path.join(repoRoot(), ".tmp", "test-curation")
		: path.resolve(process.env.CURATION_ARTIFACTS);

export const analysisDir = (): string => path.join(artifactsRoot(), "analysis");

export const ensureArtifacts = async (): Promise<void> => {
	await fs.mkdir(analysisDir(), { recursive: true });
};

export const readJson = async <T>(file: string): Promise<T> =>
	(await Bun.file(file).json()) as T;

export const writeJson = async (
	file: string,
	value: unknown
): Promise<void> => {
	await Bun.write(file, `${JSON.stringify(value, null, 2)}\n`);
};

const SCRUBBED_ENVIRONMENT_NAMES = [
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AZURE_OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"COHERE_API_KEY",
	"DATABASE_URL",
	"GITHUB_TOKEN",
	"GOOGLE_API_KEY",
	"GOOGLE_GENERATIVE_AI_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GROQ_API_KEY",
	"MISTRAL_API_KEY",
	"OPENAI_API_KEY",
	"OPENCODE_API_KEY",
	"OPENCODE_GO_API_KEY",
	"OPENROUTER_API_KEY",
	"XAI_API_KEY",
];

/** The credential-free environment the Default Test Portfolio runs under. */
export const testEnvironment = (
	overrides: Readonly<Record<string, string>> = {}
): Record<string, string> => {
	const environment: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined) {
			environment[name] = value;
		}
	}
	for (const name of SCRUBBED_ENVIRONMENT_NAMES) {
		environment[name] = "";
	}
	return { ...environment, ...overrides };
};

export const defaultTestFiles = (): readonly DiscoveredTestFile[] =>
	testsForClassification(discoverTests(repoRoot()), "default");

export type TestResult = {
	assertions: number;
	file: string;
	line: number;
	name: string;
	status: "failed" | "passed" | "skipped";
	suite: string;
	timeMs: number;
};

const decodeXml = (value: string): string =>
	value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&#10;", "\n")
		.replaceAll("&amp;", "&");

const attribute = (tag: string, name: string): string | undefined => {
	const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
	return match?.[1] === undefined ? undefined : decodeXml(match[1]);
};

const FAILURE_TAG_PATTERN = /<failure\b/;
const SKIPPED_TAG_PATTERN = /<skipped\b/;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[tj]sx?$/;

const junitStatus = (body: string): TestResult["status"] => {
	if (FAILURE_TAG_PATTERN.test(body)) {
		return "failed";
	}
	return SKIPPED_TAG_PATTERN.test(body) ? "skipped" : "passed";
};

export const parseJunit = (xml: string): TestResult[] => {
	const results: TestResult[] = [];
	const pattern = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
	for (const match of xml.matchAll(pattern)) {
		const attributes = `<testcase ${match[1] ?? ""}>`;
		const body = match[3] ?? "";
		const file = attribute(attributes, "file");
		if (file === undefined) {
			continue;
		}
		results.push({
			assertions: Number(attribute(attributes, "assertions") ?? 0),
			file,
			line: Number(attribute(attributes, "line") ?? 0),
			name: attribute(attributes, "name") ?? "",
			status: junitStatus(body),
			suite: attribute(attributes, "classname") ?? "",
			timeMs: Number(attribute(attributes, "time") ?? 0) * 1000,
		});
	}
	return results;
};

/** Loads one labeled JUnit run, ordered by file then line. */
export const loadJunitRun = async (
	root: string,
	label: string
): Promise<TestResult[]> => {
	const directory = path.join(root, "junit", label);
	const results: TestResult[] = [];
	for (const entry of await fs.readdir(directory)) {
		if (!entry.endsWith(".xml")) {
			continue;
		}
		results.push(
			...parseJunit(await Bun.file(path.join(directory, entry)).text())
		);
	}
	return results.sort((left, right) => {
		if (left.file === right.file) {
			return left.line - right.line;
		}
		return left.file < right.file ? -1 : 1;
	});
};

export type LcovRecord = {
	branches: string[];
	lines: string[];
	source: string;
};

/** Parses one lcov report that Bun writes; Bun emits DA records, not BRDA. */
export const parseLcov = (text: string): LcovRecord[] => {
	const records: LcovRecord[] = [];
	let source: string | undefined;
	let lines: string[] = [];
	let branches: string[] = [];
	const flush = (): void => {
		if (source !== undefined) {
			records.push({ branches, lines, source });
		}
		source = undefined;
		lines = [];
		branches = [];
	};
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line.startsWith("SF:")) {
			source = line.slice(3);
			continue;
		}
		if (line === "end_of_record") {
			flush();
			continue;
		}
		if (line.startsWith("DA:")) {
			const [lineNumber, hits] = line.slice(3).split(",");
			if (lineNumber !== undefined && Number(hits) > 0) {
				lines.push(lineNumber);
			}
			continue;
		}
		if (line.startsWith("BRDA:")) {
			const [branchLine, block, branch, taken] = line.slice(5).split(",");
			if (
				branchLine !== undefined &&
				block !== undefined &&
				branch !== undefined &&
				taken !== undefined &&
				taken !== "-" &&
				Number(taken) > 0
			) {
				branches.push(`${branchLine}:${block}:${branch}`);
			}
		}
	}
	flush();
	return records;
};

/** Application code only: no tests, dependencies, generated output or builds. */
export const isApplicationFile = (relativePath: string): boolean => {
	if (relativePath.includes("node_modules/")) {
		return false;
	}
	if (relativePath.includes("/test/") || relativePath.startsWith("test/")) {
		return false;
	}
	if (
		relativePath.includes("/dist/") ||
		relativePath.includes("/generated/") ||
		relativePath.includes(".generated.")
	) {
		return false;
	}
	if (TEST_FILE_PATTERN.test(relativePath)) {
		return false;
	}
	return (
		relativePath.startsWith("packages/") || relativePath.startsWith("scripts/")
	);
};

export const applicationLineKey = (
	source: string,
	line: string
): string | undefined => {
	const normalized = source.split(path.sep).join("/");
	return isApplicationFile(normalized) ? `${normalized}:${line}` : undefined;
};

/** True when the path exists and can be read as UTF-8 text. */
export const isReadableFile = async (target: string): Promise<boolean> => {
	try {
		await Bun.file(target).text();
		return true;
	} catch {
		return false;
	}
};

export const slug = (value: string): string =>
	value.replace(/[^a-zA-Z0-9._-]+/g, "_");

export const runBunTest = async (
	args: readonly string[],
	options: Readonly<{
		cwd?: string;
		env?: Record<string, string>;
		logPath?: string;
		timeoutMs?: number;
	}> = {}
): Promise<{
	exitCode: number;
	stderr: string;
	stdout: string;
	wallMs: number;
}> => {
	const started = Bun.nanoseconds();
	const child = Bun.spawn(["bun", "--no-env-file", ...args], {
		cwd: options.cwd ?? repoRoot(),
		env: options.env ?? testEnvironment(),
		signal:
			options.timeoutMs === undefined
				? undefined
				: AbortSignal.timeout(options.timeoutMs),
		stdin: "ignore",
		stderr: "pipe",
		stdout: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (options.logPath !== undefined) {
		await Bun.write(
			options.logPath,
			`$ bun --no-env-file ${args.join(" ")}\n\n${stdout}${stderr}`
		);
	}
	return {
		exitCode,
		stderr,
		stdout,
		wallMs: Number(Bun.nanoseconds() - started) / 1e6,
	};
};

/**
 * Creates a detached worktree for fault injection so the live tree is never
 * mutated, and links the dependency directories the tests resolve through.
 */
export const createWorktree = async (): Promise<string> => {
	const directory = path.join(artifactsRoot(), "worktree");
	await fs.rm(directory, { force: true, recursive: true });
	await $`git worktree prune`.cwd(repoRoot()).quiet().nothrow();
	const added = await $`git worktree add --detach ${directory} HEAD`
		.cwd(repoRoot())
		.quiet()
		.nothrow();
	if (added.exitCode !== 0) {
		throw new Error(`git worktree add failed: ${added.stderr.toString()}`);
	}
	const exists = async (target: string): Promise<boolean> => {
		try {
			await fs.stat(target);
			return true;
		} catch {
			return false;
		}
	};
	const link = async (from: string, to: string): Promise<void> => {
		if (await exists(from)) {
			await fs.symlink(from, to);
		}
	};
	await link(
		path.join(repoRoot(), "node_modules"),
		path.join(directory, "node_modules")
	);
	for (const entry of await fs.readdir(path.join(repoRoot(), "packages"), {
		withFileTypes: true,
	})) {
		if (!entry.isDirectory()) {
			continue;
		}
		await fs.mkdir(path.join(directory, "packages", entry.name), {
			recursive: true,
		});
		await link(
			path.join(repoRoot(), "packages", entry.name, "node_modules"),
			path.join(directory, "packages", entry.name, "node_modules")
		);
	}
	return directory;
};

export const removeWorktree = async (directory: string): Promise<void> => {
	await $`git worktree remove --force ${directory}`
		.cwd(repoRoot())
		.quiet()
		.nothrow();
};
