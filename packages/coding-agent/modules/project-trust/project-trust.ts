import type { Dirent } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { logger, readUtf8File } from "@wincode/utils";
import { canonicalPath, getProjectRoots } from "@/shared/paths/project-roots";

export type ProjectTrustDecision = "trust" | "deny";
export type ProjectTrustOverride = ProjectTrustDecision;
export type ProjectTrustPrompt = (
	projectRoot: string
) => Promise<ProjectTrustDecision>;

export type ProjectTrustResolution = Readonly<{
	diagnostics: readonly string[];
	trustedProjectRoots: readonly string[];
}>;

export type ResolveProjectTrustInput = Readonly<{
	mode: "interactive" | "print" | "json" | "rpc" | "sdk";
	override?: ProjectTrustOverride;
	prompt?: ProjectTrustPrompt;
	stdinIsTTY?: boolean;
	userDataDir: string;
	workspace: string;
}>;

type StoredTrustDecision = Readonly<{
	decision: ProjectTrustDecision;
	directory: string;
}>;

type TrustFile = Readonly<{
	decisions: readonly StoredTrustDecision[];
	version: 1;
}>;

const TRUST_FILE_NAME = "project-trust.json";
const CONFIG_NAMES = ["wincode.json", "wincode.jsonc"] as const;
const PROJECT_SKILL_ROOTS = [
	".agents/skills",
	".claude/skills",
	".opencode/skills",
	".wincode/skills",
] as const;
const PROJECT_COMMAND_ROOT = ".wincode/commands";

const pathContains = (parent: string, target: string): boolean => {
	const relative = path.relative(parent, target);
	return (
		relative === "" ||
		(relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
};

const exists = async (filePath: string): Promise<boolean> =>
	await Bun.file(filePath).exists();

const hasProjectSkill = async (projectRoot: string): Promise<boolean> => {
	for (const relativeRoot of PROJECT_SKILL_ROOTS) {
		const skillRoot = path.join(projectRoot, relativeRoot);
		let entries: Dirent[];
		try {
			entries = await readdir(skillRoot, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (
				entry.isDirectory() &&
				(await exists(path.join(skillRoot, entry.name, "SKILL.md")))
			) {
				return true;
			}
		}
	}
	return false;
};

const hasProjectCommand = async (projectRoot: string): Promise<boolean> => {
	const commandRoot = path.join(projectRoot, PROJECT_COMMAND_ROOT);
	try {
		const entries = await readdir(commandRoot, { withFileTypes: true });
		return entries.some(
			(entry) => entry.isFile() && entry.name.endsWith(".md")
		);
	} catch {
		return false;
	}
};

const hasProtectedProjectResources = async (
	projectRoot: string
): Promise<boolean> => {
	for (const configRoot of [projectRoot, path.join(projectRoot, ".wincode")]) {
		for (const name of CONFIG_NAMES) {
			if (await exists(path.join(configRoot, name))) {
				return true;
			}
		}
	}
	return (
		(await hasProjectSkill(projectRoot)) ||
		(await hasProjectCommand(projectRoot))
	);
};

const loadTrustFile = async (
	filePath: string
): Promise<StoredTrustDecision[]> => {
	try {
		const parsed: unknown = JSON.parse(await readUtf8File(filePath));
		if (typeof parsed !== "object" || parsed === null) {
			return [];
		}
		const rawDecisions = Reflect.get(parsed, "decisions") as unknown;
		if (!Array.isArray(rawDecisions) || Reflect.get(parsed, "version") !== 1) {
			return [];
		}
		return rawDecisions.flatMap((candidate: unknown) => {
			if (typeof candidate !== "object" || candidate === null) {
				return [];
			}
			const directory = Reflect.get(candidate, "directory") as unknown;
			const decision = Reflect.get(candidate, "decision") as unknown;
			return typeof directory === "string" &&
				path.isAbsolute(directory) &&
				(decision === "trust" || decision === "deny")
				? [{ directory, decision }]
				: [];
		});
	} catch {
		return [];
	}
};

const saveTrustFile = async (
	filePath: string,
	decisions: readonly StoredTrustDecision[]
): Promise<void> => {
	await mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await writeFile(
			temporaryPath,
			JSON.stringify({ decisions, version: 1 } satisfies TrustFile, null, 2),
			{ encoding: "utf8", mode: 0o600 }
		);
		await rename(temporaryPath, filePath);
	} finally {
		await rm(temporaryPath, { force: true });
	}
};

const nearestDecision = (
	projectRoot: string,
	decisions: readonly StoredTrustDecision[]
): StoredTrustDecision | undefined =>
	decisions
		.filter(({ directory }) => pathContains(directory, projectRoot))
		.toSorted(
			(first, second) =>
				second.directory.length - first.directory.length ||
				first.directory.localeCompare(second.directory)
		)
		.at(0);

/** Resolves user-owned trust before the application reads project config or resources. */
export const resolveProjectTrust = async ({
	mode,
	override,
	prompt,
	stdinIsTTY = false,
	userDataDir,
	workspace,
}: ResolveProjectTrustInput): Promise<ProjectTrustResolution> => {
	const projectRoots = await Promise.all(
		getProjectRoots(workspace).map((root) => canonicalPath(root))
	);
	const protectedRoots = (
		await Promise.all(
			projectRoots.map(async (root) =>
				(await hasProtectedProjectResources(root)) ? root : undefined
			)
		)
	).filter((root): root is string => root !== undefined);
	const trustFilePath = path.join(userDataDir, TRUST_FILE_NAME);
	const storedDecisions = await loadTrustFile(trustFilePath);
	const decisionsByCanonicalDirectory = new Map<string, StoredTrustDecision>();
	for (const entry of storedDecisions) {
		const directory = await canonicalPath(entry.directory);
		const prior = decisionsByCanonicalDirectory.get(directory);
		decisionsByCanonicalDirectory.set(directory, {
			directory,
			decision:
				prior?.decision === "deny" || entry.decision === "deny"
					? "deny"
					: "trust",
		});
	}
	const decisions = [...decisionsByCanonicalDirectory.values()];
	const promptDecisions: StoredTrustDecision[] = [];
	const trustedProjectRoots = new Set<string>();
	const diagnostics: string[] = [];

	for (const projectRoot of protectedRoots) {
		let decision = nearestDecision(projectRoot, decisions)?.decision;
		if (override !== undefined) {
			decision = override;
		}
		if (
			decision === undefined &&
			mode === "interactive" &&
			stdinIsTTY &&
			prompt !== undefined
		) {
			decision = await prompt(projectRoot);
			promptDecisions.push({ decision, directory: projectRoot });
		}
		if (decision === "trust") {
			trustedProjectRoots.add(projectRoot);
			continue;
		}
		diagnostics.push(
			`Skipped protected project resources from untrusted directory ${projectRoot}; use --trust-project for this invocation to load them.`
		);
	}

	if (promptDecisions.length > 0) {
		const decisionsByDirectory = new Map(
			decisions.map((entry) => [entry.directory, entry])
		);
		for (const entry of promptDecisions) {
			decisionsByDirectory.set(entry.directory, entry);
		}
		await saveTrustFile(trustFilePath, [...decisionsByDirectory.values()]);
	}
	if (diagnostics.length > 0) {
		await logger.warn(
			"Project resources were omitted because they are untrusted.",
			{
				operation: "project-trust.resolve",
				workspace,
			}
		);
	}

	return Object.freeze({
		diagnostics: Object.freeze(diagnostics),
		trustedProjectRoots: Object.freeze(
			[...trustedProjectRoots].flatMap((root) => [root, path.resolve(root)])
		),
	});
};
