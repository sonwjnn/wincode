import { readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export type TestClassification = "default" | "e2e" | "external";

export type DiscoveredTestFile = {
	readonly classification: TestClassification;
	readonly packageName: string;
	readonly path: string;
};

export type TestDiscoveryIssue = {
	readonly message: string;
	readonly path: string;
};

export type TestDiscovery = {
	readonly files: readonly DiscoveredTestFile[];
	readonly issues: readonly TestDiscoveryIssue[];
};

const SUPPORTED_EXTENSIONS: Record<string, true> = { ts: true, tsx: true };
const UNSUPPORTED_CLASSIFICATIONS: Record<string, true> = {
	browser: true,
	component: true,
	default: true,
	integration: true,
	smoke: true,
	unit: true,
};
const IGNORED_DIRECTORY_NAMES: Record<string, true> = {
	".cache": true,
	".git": true,
	".turbo": true,
	build: true,
	coverage: true,
	dist: true,
	generated: true,
	node_modules: true,
	out: true,
	"test-artifacts": true,
};
const TEST_LIKE_FILE_PATTERN = /(?:\.test|\.spec)(?:\.|$)/;
const E2E_TEST_FILE_PATTERN = /\.e2e\.test\.(?:ts|tsx)$/;
const EXTERNAL_TEST_FILE_PATTERN = /\.external\.test\.(?:ts|tsx)$/;
const SPEC_TEST_FILE_PATTERN = /\.spec\.(?:ts|tsx)$/;
const CLASSIFICATION_PATTERN = /\.([a-z0-9_-]+)\.test\.(?:ts|tsx)$/i;
const DEFAULT_TEST_FILE_PATTERN = /\.test\.(?:ts|tsx)$/;
const PACKAGE_TEST_PATH_PATTERN = /^packages\/([^/]+)\/test(?:\/|$)/;
export const compareStableStrings = (left: string, right: string): number => {
	if (left < right) {
		return -1;
	}
	if (left > right) {
		return 1;
	}
	return 0;
};

const normalizePath = (pathName: string): string =>
	pathName.split(sep).join("/");

const isTestLikeFile = (fileName: string): boolean =>
	TEST_LIKE_FILE_PATTERN.test(fileName);

const issue = (
	issues: TestDiscoveryIssue[],
	path: string,
	message: string
): void => {
	issues.push({ message, path });
};

const classifyTestFile = (
	fileName: string,
	extension: string,
	issues: TestDiscoveryIssue[],
	path: string
): TestClassification | null => {
	if (!Object.hasOwn(SUPPORTED_EXTENSIONS, extension)) {
		issue(
			issues,
			path,
			`unsupported test extension .${extension || "(missing)"}; use .ts or .tsx`
		);
		return null;
	}

	if (E2E_TEST_FILE_PATTERN.test(fileName)) {
		return "e2e";
	}
	if (EXTERNAL_TEST_FILE_PATTERN.test(fileName)) {
		return "external";
	}
	if (SPEC_TEST_FILE_PATTERN.test(fileName)) {
		issue(
			issues,
			path,
			"unsupported test classification suffix .spec; use .test.ts or .test.tsx"
		);
		return null;
	}

	const classificationMatch = CLASSIFICATION_PATTERN.exec(fileName);
	const classification = classificationMatch?.[1]?.toLowerCase();
	if (
		classification &&
		Object.hasOwn(UNSUPPORTED_CLASSIFICATIONS, classification)
	) {
		issue(
			issues,
			path,
			`unsupported test classification suffix .${classification}; use .test.ts or .test.tsx for Default tests`
		);
		return null;
	}

	if (!DEFAULT_TEST_FILE_PATTERN.test(fileName)) {
		issue(
			issues,
			path,
			"unsupported test filename; use .test.ts, .test.tsx, .e2e.test.tsx, or .external.test.ts"
		);
		return null;
	}
	return "default";
};

const walk = (
	root: string,
	currentPath: string,
	visitFile: (path: string) => void
): void => {
	const directory = join(root, currentPath);
	for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
		(left, right) => compareStableStrings(left.name, right.name)
	)) {
		const entryPath = currentPath ? join(currentPath, entry.name) : entry.name;
		if (entry.isDirectory()) {
			if (
				currentPath !== "packages" &&
				Object.hasOwn(IGNORED_DIRECTORY_NAMES, entry.name)
			) {
				continue;
			}
			walk(root, entryPath, visitFile);
			continue;
		}
		if (entry.isFile()) {
			visitFile(entryPath);
		}
	}
};

export const discoverTests = (root: string): TestDiscovery => {
	const absoluteRoot = resolve(root);
	const files: DiscoveredTestFile[] = [];
	const issues: TestDiscoveryIssue[] = [];

	walk(absoluteRoot, "", (relativePath) => {
		const normalizedPath = normalizePath(relativePath);
		const fileName = normalizedPath.split("/").at(-1) ?? normalizedPath;
		if (!isTestLikeFile(fileName)) {
			return;
		}

		const packageTestMatch = PACKAGE_TEST_PATH_PATTERN.exec(normalizedPath);
		if (!packageTestMatch) {
			issue(
				issues,
				normalizedPath,
				"test files must live under a package-root packages/<package>/test tree"
			);
			return;
		}

		const extension = fileName.split(".").at(-1) ?? "";
		const classification = classifyTestFile(
			fileName,
			extension,
			issues,
			normalizedPath
		);
		if (!classification) {
			return;
		}
		const packageName = packageTestMatch[1];
		if (!packageName) {
			return;
		}
		files.push({ classification, packageName, path: normalizedPath });
	});

	files.sort((left, right) => compareStableStrings(left.path, right.path));
	issues.sort((left, right) => compareStableStrings(left.path, right.path));
	return { files, issues };
};

export const testsForClassification = (
	discovery: TestDiscovery,
	classification: TestClassification
): readonly DiscoveredTestFile[] =>
	discovery.files.filter((file) => file.classification === classification);

export const groupTestsByPackage = (
	files: readonly DiscoveredTestFile[]
): ReadonlyMap<string, readonly DiscoveredTestFile[]> => {
	const grouped = new Map<string, DiscoveredTestFile[]>();
	for (const file of files) {
		const packageFiles = grouped.get(file.packageName);
		if (packageFiles) {
			packageFiles.push(file);
			continue;
		}
		grouped.set(file.packageName, [file]);
	}
	return grouped;
};
