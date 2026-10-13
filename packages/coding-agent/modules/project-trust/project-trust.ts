import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, readUtf8File } from "@wincode/utils";
import { canonicalPath, getProjectRoots } from "@/shared/paths/project-roots";
import {
	PROJECT_COMMAND_ROOT,
	PROJECT_SKILL_ROOTS,
} from "./project-resource-roots";

export type ProjectTrustDecision = "trust" | "deny";
export type ProjectTrustOverride = ProjectTrustDecision;
export type ProjectTrustChoice =
	| ProjectTrustDecision
	| "trust-parent"
	| "trust-session"
	| "deny-session"
	| "cancel";
export type ProjectTrustSelection = Exclude<ProjectTrustChoice, "cancel">;
export type ProjectTrustSelectionResolution = Readonly<{
	decision: ProjectTrustDecision;
	/** Session selections apply to the running process and are never saved. */
	persist: boolean;
	scope: "parent" | "project";
}>;
export type ProjectTrustSessionStatus = "trusted" | "untrusted" | "pending";

const PROJECT_TRUST_SELECTION_RESOLUTIONS = {
	deny: { decision: "deny", persist: true, scope: "project" },
	"deny-session": { decision: "deny", persist: false, scope: "project" },
	trust: { decision: "trust", persist: true, scope: "project" },
	"trust-parent": { decision: "trust", persist: true, scope: "parent" },
	"trust-session": { decision: "trust", persist: false, scope: "project" },
} as const satisfies Record<
	ProjectTrustSelection,
	ProjectTrustSelectionResolution
>;

export const resolveProjectTrustSelection = (
	selection: ProjectTrustSelection
): ProjectTrustSelectionResolution =>
	PROJECT_TRUST_SELECTION_RESOLUTIONS[selection];

export type ProjectTrustSavedDecision = Readonly<{
	decision: ProjectTrustDecision;
	directory: string;
	inherited: boolean;
}>;

export type ProjectTrustRootStatus = Readonly<{
	currentSessionStatus: ProjectTrustSessionStatus;
	projectRoot: string;
	savedDecision?: ProjectTrustSavedDecision;
}>;

export type ProjectTrustPromptRequest = Readonly<{
	parentDirectory?: string;
	protectedRoots: readonly ProjectTrustRootStatus[];
	workspace: string;
}>;

export type ProjectTrustPrompt = (
	request: ProjectTrustPromptRequest
) => Promise<ProjectTrustChoice>;

export type ProjectTrustResolution = Readonly<{
	diagnostics: readonly string[];
	sessionDecision?: ProjectTrustDecision;
	trustedProjectRoots: readonly string[];
	untrustedProjectRoots: readonly string[];
}>;

export type ProjectTrustStatus = Readonly<{
	currentSessionTrusted: boolean;
	parentDirectory?: string;
	protectedRoots: readonly ProjectTrustRootStatus[];
}>;

export type ResolveProjectTrustInput = Readonly<{
	mode: "interactive" | "print" | "json" | "rpc" | "sdk";
	override?: ProjectTrustOverride;
	prompt?: ProjectTrustPrompt;
	stdinIsTTY?: boolean;
	projectTrustDir: string;
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
const CONFIG_NAMES = ["settings.json", "settings.jsonc", "mcp.json"] as const;

const pathContains = (parent: string, target: string): boolean => {
	const relative = path.relative(parent, target);
	return (
		relative === "" ||
		(relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
};

/** Trusted and untrusted roots share one shape so consumers can rely on both. */
const expandProjectRoots = (roots: readonly string[]): readonly string[] =>
	Object.freeze(roots.flatMap((root) => [root, path.resolve(root)]));

const exists = async (filePath: string): Promise<boolean> =>
	await Bun.file(filePath).exists();

const hasProjectSkill = async (projectRoot: string): Promise<boolean> => {
	for (const relativeRoot of PROJECT_SKILL_ROOTS) {
		const skillRoot = path.join(projectRoot, relativeRoot);
		let entries: nodeFs.Dirent[];
		try {
			entries = await fs.readdir(skillRoot, { withFileTypes: true });
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
		const entries = await fs.readdir(commandRoot, {
			withFileTypes: true,
		});
		return entries.some(
			(entry) => entry.isFile() && entry.name.endsWith(".md")
		);
	} catch {
		return false;
	}
};

const hasProjectAgentDefinition = async (
	projectRoot: string
): Promise<boolean> => {
	const agentRoot = path.join(projectRoot, ".wincode", "agents");
	const visit = async (directory: string): Promise<boolean> => {
		let entries: nodeFs.Dirent[];
		try {
			entries = await fs.readdir(directory, { withFileTypes: true });
		} catch {
			return false;
		}
		for (const entry of entries) {
			if (entry.isFile() && path.extname(entry.name) === ".md") {
				return true;
			}
			if (
				entry.isDirectory() &&
				(await visit(path.join(directory, entry.name)))
			) {
				return true;
			}
		}
		return false;
	};
	return visit(agentRoot);
};

const hasProtectedProjectResources = async (
	projectRoot: string
): Promise<boolean> => {
	const configRoot = path.join(projectRoot, ".wincode");
	for (const name of CONFIG_NAMES) {
		if (await exists(path.join(configRoot, name))) {
			return true;
		}
	}
	return (
		(await hasProjectSkill(projectRoot)) ||
		(await hasProjectCommand(projectRoot)) ||
		(await hasProjectAgentDefinition(projectRoot))
	);
};

const getProtectedProjectRoots = async (
	workspace: string
): Promise<string[]> => {
	const projectRoots = await Promise.all(
		getProjectRoots(workspace).map((root) => canonicalPath(root))
	);
	return (
		await Promise.all(
			projectRoots.map(async (root) =>
				(await hasProtectedProjectResources(root)) ? root : undefined
			)
		)
	).filter((root): root is string => root !== undefined);
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

const canonicalizeTrustDecisions = async (
	storedDecisions: readonly StoredTrustDecision[]
): Promise<StoredTrustDecision[]> => {
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
	return [...decisionsByCanonicalDirectory.values()];
};

const saveTrustFile = async (
	filePath: string,
	decisions: readonly StoredTrustDecision[]
): Promise<void> => {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.writeFile(
			temporaryPath,
			JSON.stringify({ decisions, version: 1 } satisfies TrustFile, null, 2),
			{ encoding: "utf8", mode: 0o600 }
		);
		await fs.rename(temporaryPath, filePath);
	} finally {
		await fs.rm(temporaryPath, { force: true });
	}
};

export const saveProjectTrustDecision = async ({
	decision,
	projectTrustDir,
	scope = "project",
	workspace,
}: Readonly<{
	decision: ProjectTrustDecision;
	projectTrustDir: string;
	scope?: "parent" | "project";
	workspace: string;
}>): Promise<void> => {
	const canonicalWorkspace = await canonicalPath(workspace);
	const protectedRoots = await getProtectedProjectRoots(workspace);
	const targetRoots =
		protectedRoots.length > 0 ? protectedRoots : [canonicalWorkspace];
	const trustFilePath = path.join(projectTrustDir, TRUST_FILE_NAME);
	const storedDecisions = await canonicalizeTrustDecisions(
		await loadTrustFile(trustFilePath)
	);
	const decisionsByDirectory = new Map(
		storedDecisions.map((entry) => [entry.directory, entry])
	);
	if (scope === "parent") {
		for (const directory of targetRoots) {
			decisionsByDirectory.delete(directory);
		}
		const parentDirectory = path.dirname(canonicalWorkspace);
		decisionsByDirectory.set(parentDirectory, {
			decision,
			directory: parentDirectory,
		});
	} else {
		for (const directory of targetRoots) {
			decisionsByDirectory.set(directory, { decision, directory });
		}
	}
	await saveTrustFile(trustFilePath, [...decisionsByDirectory.values()]);
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

const getSavedDecisionForRoot = (
	projectRoot: string,
	decisions: readonly StoredTrustDecision[]
): ProjectTrustSavedDecision | undefined => {
	const decision = nearestDecision(projectRoot, decisions);
	return decision === undefined
		? undefined
		: Object.freeze({
				...decision,
				inherited: decision.directory !== projectRoot,
			});
};

const getRootStatuses = (
	protectedRoots: readonly string[],
	decisions: readonly StoredTrustDecision[],
	currentSessionStatus: (projectRoot: string) => ProjectTrustSessionStatus
): readonly ProjectTrustRootStatus[] =>
	Object.freeze(
		protectedRoots.map((projectRoot) => {
			const savedDecision = getSavedDecisionForRoot(projectRoot, decisions);
			return Object.freeze({
				currentSessionStatus: currentSessionStatus(projectRoot),
				projectRoot,
				...(savedDecision === undefined ? {} : { savedDecision }),
			});
		})
	);

export const getProjectTrustStatus = async ({
	projectTrustDir,
	trustedProjectRoots,
	workspace,
}: Readonly<{
	projectTrustDir: string;
	trustedProjectRoots: readonly string[];
	workspace: string;
}>): Promise<ProjectTrustStatus> => {
	const canonicalWorkspace = await canonicalPath(workspace);
	const protectedRoots = await getProtectedProjectRoots(workspace);
	const trustedRoots = new Set(
		trustedProjectRoots.map((root) => path.resolve(root))
	);
	const trustFilePath = path.join(projectTrustDir, TRUST_FILE_NAME);
	const decisions = await canonicalizeTrustDecisions(
		await loadTrustFile(trustFilePath)
	);
	const rootStatuses = getRootStatuses(
		protectedRoots,
		decisions,
		(projectRoot) =>
			trustedRoots.has(path.resolve(projectRoot)) ? "trusted" : "untrusted"
	);
	const parentDirectory = path.dirname(canonicalWorkspace);

	return Object.freeze({
		currentSessionTrusted: rootStatuses.every(
			({ currentSessionStatus }) => currentSessionStatus === "trusted"
		),
		...(parentDirectory === canonicalWorkspace ? {} : { parentDirectory }),
		protectedRoots: rootStatuses,
	});
};

const shouldPromptForProjectTrust = ({
	mode,
	override,
	prompt,
	stdinIsTTY,
	protectedRoots,
	decisions,
}: Pick<
	ResolveProjectTrustInput,
	"mode" | "override" | "prompt" | "stdinIsTTY"
> & {
	protectedRoots: readonly string[];
	decisions: readonly StoredTrustDecision[];
}): boolean =>
	override === undefined &&
	mode === "interactive" &&
	stdinIsTTY === true &&
	prompt !== undefined &&
	protectedRoots.some(
		(projectRoot) => nearestDecision(projectRoot, decisions) === undefined
	);

type ProjectTrustPromptOutcome = Readonly<{
	choice: ProjectTrustChoice;
	/** Present only when the prompt produced a selection; cancel has none. */
	selection?: ProjectTrustSelectionResolution;
}>;

const requestProjectTrustChoice = async ({
	mode,
	override,
	prompt,
	stdinIsTTY,
	projectTrustDir,
	parentDirectory,
	workspace,
	protectedRoots,
	decisions,
}: ResolveProjectTrustInput & {
	parentDirectory: string;
	protectedRoots: readonly string[];
	decisions: readonly StoredTrustDecision[];
}): Promise<ProjectTrustPromptOutcome | undefined> => {
	if (
		prompt === undefined ||
		!shouldPromptForProjectTrust({
			mode,
			override,
			prompt,
			stdinIsTTY,
			protectedRoots,
			decisions,
		})
	) {
		return;
	}

	const choice = await prompt({
		...(parentDirectory === workspace ? {} : { parentDirectory }),
		protectedRoots: getRootStatuses(protectedRoots, decisions, () => "pending"),
		workspace,
	});
	if (choice === "cancel") {
		return { choice };
	}
	const selection = resolveProjectTrustSelection(choice);
	if (selection.persist) {
		await saveProjectTrustDecision({
			decision: selection.decision,
			projectTrustDir,
			scope: selection.scope,
			workspace,
		});
	}
	return { choice, selection };
};

const getDecisionForRoot = (
	projectRoot: string,
	override: ProjectTrustOverride | undefined,
	prompted: ProjectTrustPromptOutcome | undefined,
	promptedParentDirectory: string,
	decisions: readonly StoredTrustDecision[]
): ProjectTrustDecision | undefined => {
	if (override !== undefined) {
		return override;
	}
	if (prompted === undefined) {
		return nearestDecision(projectRoot, decisions)?.decision;
	}
	const { selection } = prompted;
	if (selection === undefined) {
		// Cancelling refuses every protected root for this run.
		return;
	}
	if (
		selection.scope === "parent" &&
		!pathContains(promptedParentDirectory, projectRoot)
	) {
		return nearestDecision(projectRoot, decisions)?.decision;
	}
	return selection.decision;
};

/** Resolves user-owned trust before the application reads project config or resources. */
export const resolveProjectTrust = async ({
	mode,
	override,
	prompt,
	stdinIsTTY = false,
	projectTrustDir,
	workspace,
}: ResolveProjectTrustInput): Promise<ProjectTrustResolution> => {
	const protectedRoots = await getProtectedProjectRoots(workspace);
	const trustFilePath = path.join(projectTrustDir, TRUST_FILE_NAME);
	const decisions = await canonicalizeTrustDecisions(
		await loadTrustFile(trustFilePath)
	);
	const canonicalWorkspace = await canonicalPath(workspace);
	const promptedParentDirectory = path.dirname(canonicalWorkspace);
	const prompted = await requestProjectTrustChoice({
		mode,
		override,
		prompt,
		stdinIsTTY,
		projectTrustDir,
		parentDirectory: promptedParentDirectory,
		workspace: canonicalWorkspace,
		protectedRoots,
		decisions,
	});
	const trustedCanonicalRoots = new Set<string>();
	const untrustedProjectRoots: string[] = [];
	const diagnostics: string[] = [];

	for (const projectRoot of protectedRoots) {
		const decision = getDecisionForRoot(
			projectRoot,
			override,
			prompted,
			promptedParentDirectory,
			decisions
		);
		if (decision === "trust") {
			trustedCanonicalRoots.add(projectRoot);
			continue;
		}
		untrustedProjectRoots.push(projectRoot);
		// diagnostics.push(
		// 	`Skipped protected project resources from untrusted directory ${projectRoot}; use --trust-project for this invocation to load them.`
		// );
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

	const sessionDecision =
		prompted?.selection !== undefined && !prompted.selection.persist
			? prompted.selection.decision
			: undefined;

	return Object.freeze({
		diagnostics: Object.freeze(diagnostics),
		...(sessionDecision === undefined ? {} : { sessionDecision }),
		trustedProjectRoots: expandProjectRoots([...trustedCanonicalRoots]),
		untrustedProjectRoots: expandProjectRoots(untrustedProjectRoots),
	});
};
