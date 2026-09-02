import { SKILL_TOOL_INPUT_JSON_SCHEMA } from "./context";
import { hashSkillBody } from "./hash";
import type {
	Skill,
	SkillActivationSource,
	SkillContext,
	SkillPermissionDecision,
	SkillToolDefinition,
	SkillToolPart,
} from "./types";

export const MAX_ACTIVE_SKILLS = 3;
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
export const MAX_SKILL_BODY_LENGTH = 12_000;
export const MAX_SKILL_RESOURCE_PATH_LENGTH = 1024;
export const MAX_SKILL_RESOURCE_PATHS = 10;
export const MAX_SKILL_CATALOG_BYTES = 24_576;

export type SkillCatalogDiagnosticCode =
	| "invalid-skill"
	| "catalog-over-budget";

export type SkillCatalogDiagnostic = {
	readonly code: SkillCatalogDiagnosticCode;
	readonly message: string;
	readonly skillName?: string;
};

/**
 * One permitted Skill in the permission-filtered catalog. The body is part of
 * the execution-turn snapshot: it is validated here and never re-read while
 * the execution is active.
 */
export type SkillCatalogEntry = {
	readonly baseDirectory: string;
	readonly body: string;
	readonly contentHash: string;
	readonly description: string;
	readonly filePath: string;
	readonly name: string;
};

export type SkillCatalog = {
	readonly diagnostics: readonly SkillCatalogDiagnostic[];
	readonly entries: readonly SkillCatalogEntry[];
	/** False when the effective catalog exceeds its total budget. */
	readonly toolEnabled: boolean;
};

export type SkillActivationSnapshot = {
	readonly baseDirectory: string;
	readonly body: string;
	readonly contentHash: string;
	readonly name: string;
	readonly resourcePaths: readonly string[];
	readonly source: SkillActivationSource;
};

export type SkillActivationResult =
	| {
			readonly status: "already-loaded";
			readonly name: string;
			readonly contentHash: string;
	  }
	| { readonly status: "failed"; readonly error: string; readonly name: string }
	| {
			readonly limit: number;
			readonly activeSkillNames: readonly string[];
			readonly status: "limit-reached";
			readonly name: string;
	  }
	| { readonly snapshot: SkillActivationSnapshot; readonly status: "loaded" }
	| { readonly name: string; readonly status: "rejected" };

/**
 * The live `skill` tool result the model loop receives. Loaded results carry
 * the full body, the absolute base directory, and a bounded resource sample so
 * the Agent can act on them; every other status is sanitized by construction.
 */
export type SkillToolResult =
	| {
			readonly baseDirectory: string;
			readonly body: string;
			readonly contentHash: string;
			readonly name: string;
			readonly resourcePaths: readonly string[];
			readonly source: SkillActivationSource;
			readonly status: "loaded";
	  }
	| {
			readonly contentHash: string;
			readonly name: string;
			readonly status: "already-loaded";
	  }
	| { readonly name: string; readonly status: "rejected" }
	| { readonly error: string; readonly name: string; readonly status: "failed" }
	| {
			readonly activeSkillNames: readonly string[];
			readonly limit: number;
			readonly name: string;
			readonly status: "limit-reached";
	  };

/**
 * Sanitized tool state persisted to durable history and sent to the model in
 * later executions: activation metadata only, never the body, base directory,
 * or bundled resource contents.
 */
export type SanitizedSkillToolResult = {
	readonly activeSkillNames?: readonly string[];
	readonly contentHash?: string;
	readonly error?: string;
	readonly limit?: number;
	readonly name: string;
	readonly source?: SkillActivationSource;
	readonly status: SkillToolResult["status"];
};

export const sanitizeSkillToolResult = (
	result: SkillToolResult
): SanitizedSkillToolResult => {
	if (result.status === "loaded") {
		return {
			contentHash: result.contentHash,
			name: result.name,
			source: result.source,
			status: "loaded",
		};
	}
	if (result.status === "already-loaded") {
		return {
			contentHash: result.contentHash,
			name: result.name,
			status: "already-loaded",
		};
	}
	if (result.status === "failed") {
		return { error: result.error, name: result.name, status: "failed" };
	}
	if (result.status === "limit-reached") {
		return {
			activeSkillNames: result.activeSkillNames,
			limit: result.limit,
			name: result.name,
			status: "limit-reached",
		};
	}
	return { name: result.name, status: "rejected" };
};

/**
 * Identifies a dynamic `skill` tool part without importing an AI SDK message
 * type. Parts that are already sanitized (without output) pass through.
 */
export const isSkillToolPart = (part: unknown): part is SkillToolPart => {
	if (typeof part !== "object" || part === null) {
		return false;
	}
	const candidate = part as {
		state?: unknown;
		toolName?: unknown;
		type?: unknown;
	};
	return (
		candidate.type === "dynamic-tool" &&
		candidate.toolName === "skill" &&
		(candidate.state === "output-available" ||
			candidate.state === "output-error")
	);
};

/**
 * Collapses a live `skill` tool part to sanitized activation metadata. The
 * body, absolute base directory, and bundled resource paths never reach
 * durable storage.
 */
export const sanitizeSkillToolPart = (part: SkillToolPart): SkillToolPart => {
	if (part.output === undefined) {
		return part;
	}
	const parsed = sanitizeSkillToolResult(
		part.output as Parameters<typeof sanitizeSkillToolResult>[0]
	);
	if (parsed.status === "failed") {
		return {
			errorText: parsed.error ?? "Skill Activation failed",
			input: part.input,
			state: "output-error",
			toolCallId: part.toolCallId,
			toolName: "skill",
			type: "dynamic-tool",
		};
	}
	return {
		input: part.input,
		output: parsed,
		state: "output-available",
		toolCallId: part.toolCallId,
		toolName: "skill",
		type: "dynamic-tool",
	};
};

/**
 * Execution-scoped activation state for one user turn. It owns the
 * permission-filtered catalog snapshot, at most three distinct active Skills,
 * and the rejected set that prevents approval spam within the same execution.
 */
export type SkillExecution = {
	readonly catalog: SkillCatalog;
	/** Activates a Skill without a permission gate; callers must gate first. */
	activate(name: string, source: SkillActivationSource): SkillActivationResult;
	activeSnapshots(): readonly SkillActivationSnapshot[];
	markRejected(name: string): void;
	/** Caches the bundled resource sample on the active snapshot. */
	setResourceSample(name: string, paths: readonly string[]): void;
};

const skillBaseDirectory = (filePath: string): string => {
	const separator = Math.max(
		filePath.lastIndexOf("/"),
		filePath.lastIndexOf("\\")
	);
	return separator < 0 ? "." : filePath.slice(0, separator);
};

const entryFromSkill = (skill: Skill): SkillCatalogEntry => ({
	baseDirectory: skill.baseDirectory ?? skillBaseDirectory(skill.filePath),
	body: skill.body,
	contentHash: hashSkillBody(skill.body),
	description: skill.description,
	filePath: skill.filePath,
	name: skill.name,
});

/**
 * Builds the permission-filtered catalog. Denied Skills are hidden without a
 * diagnostic; invalid Skills are omitted with a diagnostic. An oversized
 * catalog disables the tool rather than truncating model-visible metadata.
 */
export const buildSkillCatalog = (
	skills: readonly Skill[],
	decideSkill: (name: string) => SkillPermissionDecision
): SkillCatalog => {
	const diagnostics: SkillCatalogDiagnostic[] = [];
	const entries: SkillCatalogEntry[] = [];
	for (const skill of skills) {
		if (decideSkill(skill.name) === "deny") {
			continue;
		}
		const nameValid =
			skill.name.length <= MAX_SKILL_NAME_LENGTH && skill.name.length > 0;
		const descriptionValid =
			skill.description.length <= MAX_SKILL_DESCRIPTION_LENGTH;
		const bodyValid = skill.body.length <= MAX_SKILL_BODY_LENGTH;
		if (!(nameValid && descriptionValid && bodyValid)) {
			diagnostics.push({
				code: "invalid-skill",
				message: `Skill "${skill.name}" exceeds a validation limit (name ${MAX_SKILL_NAME_LENGTH}, description ${MAX_SKILL_DESCRIPTION_LENGTH}, body ${MAX_SKILL_BODY_LENGTH}); omitted from the catalog`,
				skillName: skill.name,
			});
			continue;
		}
		entries.push(entryFromSkill(skill));
	}
	entries.sort((first, second) => first.name.localeCompare(second.name));

	const description = formatSkillToolDescription(entries);
	const toolEnabled =
		new TextEncoder().encode(description).byteLength <= MAX_SKILL_CATALOG_BYTES;
	if (!toolEnabled) {
		diagnostics.push({
			code: "catalog-over-budget",
			message: `The permission-filtered Skill catalog exceeds the ${MAX_SKILL_CATALOG_BYTES}-byte limit; the Skill tool is disabled for this turn`,
		});
	}
	return { diagnostics, entries, toolEnabled };
};

const formatSkillToolDescription = (
	entries: readonly SkillCatalogEntry[]
): string =>
	`Load a local Skill for the current user turn when its specialized workflow or domain knowledge clearly matches the task. Simple prompts do not need a Skill; only load one when it is relevant, and prefer the most specific match. Skill instructions apply only to the current turn.\n\n<available_skills>\n${entries
		.map((entry) => `- ${entry.name}: ${entry.description}`)
		.join("\n")}\n</available_skills>`;

export const buildSkillToolDefinition = (
	catalog: SkillCatalog
): SkillToolDefinition | undefined =>
	catalog.toolEnabled && catalog.entries.length > 0
		? {
				description: formatSkillToolDescription(catalog.entries),
				inputSchema: SKILL_TOOL_INPUT_JSON_SCHEMA,
				name: "skill",
			}
		: undefined;

/**
 * Creates a body-bearing explicit or Agent activation snapshot. The body hash
 * is always derived from the instructions that will be sent to the model.
 */
export const createSkillSnapshot = (
	skill: SkillContext,
	source: SkillActivationSource
) => ({
	...skill,
	contentHash: hashSkillBody(skill.instructions),
	source,
});

export function createSkillExecution(catalog: SkillCatalog): SkillExecution {
	const active = new Map<string, SkillActivationSnapshot>();
	const rejected = new Set<string>();

	return {
		catalog,
		activate(name, source) {
			if (rejected.has(name)) {
				return { name, status: "rejected" };
			}
			const existing = active.get(name);
			if (existing) {
				return {
					contentHash: existing.contentHash,
					name,
					status: "already-loaded",
				};
			}
			if (active.size >= MAX_ACTIVE_SKILLS) {
				return {
					activeSkillNames: [...active.keys()],
					limit: MAX_ACTIVE_SKILLS,
					name,
					status: "limit-reached",
				};
			}
			const entry = catalog.entries.find(
				({ name: entryName }) => entryName === name
			);
			if (!entry) {
				return { error: `Unknown Skill "${name}"`, name, status: "failed" };
			}
			const snapshot: SkillActivationSnapshot = {
				baseDirectory: entry.baseDirectory,
				body: entry.body,
				contentHash: entry.contentHash,
				name,
				resourcePaths: [],
				source,
			};
			active.set(name, snapshot);
			return { snapshot, status: "loaded" };
		},
		activeSnapshots() {
			return [...active.values()];
		},
		markRejected(name) {
			rejected.add(name);
		},
		setResourceSample(name, paths) {
			const snapshot = active.get(name);
			if (snapshot) {
				active.set(name, { ...snapshot, resourcePaths: paths });
			}
		},
	};
}
