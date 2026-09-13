import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { spawn } from "bun";
import {
	type DiscoveredTestFile,
	discoverTests,
	groupTestsByPackage,
	type TestClassification,
	type TestDiscovery,
	testsForClassification,
} from "./test-discovery";

const TEST_TIMEOUT_MS = 30_000;
const ARTIFACT_ROOT_NAME = "test-artifacts/e2e";
const RUNNER_LOG_NAME = "runner.log";
const TERMINAL_FRAME_NAME = "terminal-frame.txt";
const E2E_SCENARIO_SUFFIX_PATTERN = /\.e2e\.test\.(?:ts|tsx)$/;
const SCENARIO_PATH_SEPARATOR_PATTERN = /[\\/]/g;
const SCENARIO_UNSAFE_CHARACTER_PATTERN = /[^a-zA-Z0-9._-]/g;
const RETAINED_ARTIFACT_ENTRIES: Record<string, true> = {
	[RUNNER_LOG_NAME]: true,
	[TERMINAL_FRAME_NAME]: true,
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
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GROQ_API_KEY",
	"MISTRAL_API_KEY",
	"OPENAI_API_KEY",
	"OPENCODE_API_KEY",
	"OPENCODE_GO_API_KEY",
	"OPENROUTER_API_KEY",
	"XAI_API_KEY",
];

type RunnerArguments = {
	readonly packageFilter?: string;
	readonly portfolio: TestClassification;
	readonly root: string;
};

type OutputWriter = {
	readonly write: (chunk: string) => boolean;
};

const usage = (): string =>
	"Usage: bun scripts/test-portfolio.ts <default|e2e> [--package <name>] [--root <path>]";

const parseArguments = (argv: readonly string[]): RunnerArguments => {
	const portfolio = argv[0];
	if (portfolio !== "default" && portfolio !== "e2e") {
		throw new Error(usage());
	}

	let packageFilter: string | undefined;
	let root = resolve(import.meta.dir, "..");
	for (let index = 1; index < argv.length; index += 1) {
		const argument = argv[index];
		if (!argument) {
			throw new Error(usage());
		}
		if (argument === "--package" || argument === "--root") {
			const value = argv[index + 1];
			if (!value) {
				throw new Error(`${argument} requires a value.\n${usage()}`);
			}
			if (argument === "--package") {
				packageFilter = value;
			} else {
				root = resolve(process.cwd(), value);
			}
			index += 1;
			continue;
		}
		if (argument.startsWith("--package=")) {
			packageFilter = argument.slice("--package=".length);
			continue;
		}
		if (argument.startsWith("--root=")) {
			root = resolve(process.cwd(), argument.slice("--root=".length));
			continue;
		}
		throw new Error(`Unknown argument: ${argument}\n${usage()}`);
	}

	return { packageFilter, portfolio, root };
};

const createTestEnvironment = (
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

const runDefaultPackage = async (
	root: string,
	packageName: string,
	files: readonly DiscoveredTestFile[]
): Promise<number> => {
	console.log(
		`\nRunning Default package: ${packageName} (${files.length} files)`
	);
	const result = spawn(
		[
			"bun",
			"test",
			"--timeout",
			String(TEST_TIMEOUT_MS),
			"--no-orphans",
			...files.map((file) => file.path),
		],
		{
			cwd: root,
			env: createTestEnvironment(),
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		}
	);
	return result.exited;
};

const scenarioName = (root: string, file: DiscoveredTestFile): string => {
	const packageRoot = join(root, "packages", file.packageName, "test");
	const fileName = relative(packageRoot, join(root, file.path));
	return fileName
		.replace(E2E_SCENARIO_SUFFIX_PATTERN, "")
		.replace(SCENARIO_PATH_SEPARATOR_PATTERN, "-")
		.replace(SCENARIO_UNSAFE_CHARACTER_PATTERN, "-");
};

const writeCombinedOutput = async (
	stream: ReadableStream<Uint8Array>,
	writer: OutputWriter,
	log: string[]
): Promise<void> => {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) {
				break;
			}
			const text = decoder.decode(result.value, { stream: true });
			if (text) {
				log.push(text);
				writer.write(text);
			}
		}
		const remaining = decoder.decode();
		if (remaining) {
			log.push(remaining);
			writer.write(remaining);
		}
	} finally {
		reader.releaseLock();
	}
};

const removeIfEmpty = async (path: string): Promise<void> => {
	try {
		if ((await readdir(path)).length === 0) {
			await rm(path, { force: true, recursive: true });
		}
	} catch {
		// The artifact directory may not exist after a failed spawn.
	}
};

const ensureTerminalFrame = async (framePath: string): Promise<void> => {
	try {
		await access(framePath);
	} catch {
		await writeFile(framePath, "", "utf8");
	}
};

const retainE2EFailure = async (
	artifactDirectory: string,
	log: readonly string[]
): Promise<void> => {
	await mkdir(artifactDirectory, { recursive: true });
	for (const entry of await readdir(artifactDirectory, {
		withFileTypes: true,
	})) {
		if (!RETAINED_ARTIFACT_ENTRIES[entry.name]) {
			await rm(join(artifactDirectory, entry.name), {
				force: true,
				recursive: true,
			});
		}
	}
	await ensureTerminalFrame(join(artifactDirectory, TERMINAL_FRAME_NAME));
	await writeFile(
		join(artifactDirectory, RUNNER_LOG_NAME),
		log.join(""),
		"utf8"
	);
};

const runE2EFile = async (
	root: string,
	file: DiscoveredTestFile
): Promise<number> => {
	const artifactDirectory = join(
		root,
		ARTIFACT_ROOT_NAME,
		file.packageName,
		scenarioName(root, file)
	);
	await rm(artifactDirectory, { force: true, recursive: true });
	await mkdir(artifactDirectory, { recursive: true });
	const log: string[] = [];
	const framePath = join(artifactDirectory, TERMINAL_FRAME_NAME);

	try {
		const result = spawn(
			[
				"bun",
				"test",
				"--timeout",
				String(TEST_TIMEOUT_MS),
				"--no-orphans",
				file.path,
			],
			{
				cwd: root,
				env: createTestEnvironment({
					WINCODE_E2E_ARTIFACT_DIR: artifactDirectory,
					WINCODE_E2E_FRAME_PATH: framePath,
				}),
				stdin: "inherit",
				stdout: "pipe",
				stderr: "pipe",
			}
		);
		const outputTasks = [
			writeCombinedOutput(result.stdout, process.stdout, log),
			writeCombinedOutput(result.stderr, process.stderr, log),
		];
		const exitCode = await result.exited;
		await Promise.all(outputTasks);
		if (exitCode === 0) {
			await rm(artifactDirectory, { force: true, recursive: true });
			await removeIfEmpty(dirname(artifactDirectory));
			await removeIfEmpty(dirname(dirname(artifactDirectory)));
			return 0;
		}
		await retainE2EFailure(artifactDirectory, log);
		return exitCode;
	} catch (error) {
		const message =
			error instanceof Error ? (error.stack ?? error.message) : String(error);
		log.push(message);
		process.stderr.write(`${message}\n`);
		await retainE2EFailure(artifactDirectory, log);
		return 1;
	}
};

const printDiscoveryIssues = (discovery: TestDiscovery): void => {
	for (const entry of discovery.issues) {
		console.error(`Test discovery error: ${entry.path}: ${entry.message}`);
	}
};

const packageMatches = (
	packageName: string,
	packageFilter: string | undefined
): boolean =>
	packageFilter === undefined ||
	packageFilter === packageName ||
	packageFilter === `@wincode/${packageName}`;

const runDefaultPortfolio = async (
	root: string,
	packageFilter: string | undefined
): Promise<number> => {
	const discovery = discoverTests(root);
	const files = testsForClassification(discovery, "default");
	console.log(`Discovered Default test files: ${files.length}`);
	if (discovery.issues.length > 0) {
		printDiscoveryIssues(discovery);
		console.log("Executed Default test files: 0");
		return 1;
	}

	const grouped = groupTestsByPackage(files);
	const failures: {
		readonly exitCode: number;
		readonly packageName: string;
	}[] = [];
	let executed = 0;
	for (const packageName of [...grouped.keys()].sort()) {
		if (!packageMatches(packageName, packageFilter)) {
			continue;
		}
		const packageFiles = grouped.get(packageName);
		if (!packageFiles) {
			continue;
		}
		executed += packageFiles.length;
		const exitCode = await runDefaultPackage(root, packageName, packageFiles);
		if (exitCode !== 0) {
			failures.push({ exitCode, packageName });
		}
	}
	console.log(`\nExecuted Default test files: ${executed}`);
	if (failures.length > 0) {
		for (const failure of failures) {
			console.error(
				`Default package failed: ${failure.packageName} (exit ${failure.exitCode})`
			);
		}
		return failures[0]?.exitCode || 1;
	}
	return 0;
};

const runE2EPortfolio = async (
	root: string,
	packageFilter: string | undefined
): Promise<number> => {
	const discovery = discoverTests(root);
	const files = testsForClassification(discovery, "e2e");
	console.log(`Discovered E2E test files: ${files.length}`);
	if (discovery.issues.length > 0) {
		printDiscoveryIssues(discovery);
		console.log("Executed E2E test files: 0");
		return 1;
	}

	let executed = 0;
	for (const file of files) {
		if (!packageMatches(file.packageName, packageFilter)) {
			continue;
		}
		executed += 1;
		console.log(`\nRunning E2E test: ${file.path}`);
		const exitCode = await runE2EFile(root, file);
		if (exitCode !== 0) {
			console.log(`\nExecuted E2E test files: ${executed}`);
			console.error(`E2E test failed: ${file.path} (exit ${exitCode})`);
			return exitCode || 1;
		}
	}
	console.log(`\nExecuted E2E test files: ${executed}`);
	return 0;
};

export const runTestPortfolio = async (
	argv: readonly string[]
): Promise<number> => {
	try {
		const arguments_ = parseArguments(argv);
		if (arguments_.portfolio === "default") {
			return runDefaultPortfolio(arguments_.root, arguments_.packageFilter);
		}
		return runE2EPortfolio(arguments_.root, arguments_.packageFilter);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		return 2;
	}
};

if (import.meta.main) {
	process.exitCode = await runTestPortfolio(process.argv.slice(2));
}
