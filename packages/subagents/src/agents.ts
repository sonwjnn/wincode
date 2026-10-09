import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	agentIdSchema,
	agentLabelFromId,
	MAX_AGENT_INSTRUCTIONS_LENGTH,
} from "@wincode/agent-core";
import {
	resolveAgentModelSelection,
	thinkingLevelSchema,
} from "@wincode/ai/models";
import type { PluginAgentRegistration } from "@wincode/coding-agent";
import { getErrorMessage, readUtf8File } from "@wincode/utils";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const toolNameListSchema = z.preprocess(
	(value: unknown) =>
		typeof value === "string"
			? value
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean)
			: value,
	z.array(z.string().trim().min(1).max(128)).max(128).optional()
);

const agentFilePattern =
	/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/u;

const agentFrontmatterSchema = z
	.object({
		description: z.string().trim().min(1).max(512),
		disabled: z.boolean().optional(),
		model: z.string().trim().min(1).optional(),
		name: agentIdSchema,
		thinkingLevel: thinkingLevelSchema.optional(),
		role: z.enum(["subagent", "all"]).optional(),
		requiredTools: toolNameListSchema,
		tools: toolNameListSchema,
	})
	.strict()
	.superRefine((selection, context) => {
		const validation = resolveAgentModelSelection(selection);
		if (validation.invalidModel) {
			context.addIssue({
				code: "custom",
				message: "Model must be a supported Model Catalog selection",
				path: ["model"],
			});
		}
		if (validation.invalidThinkingLevel) {
			context.addIssue({
				code: "custom",
				message:
					"Thinking level requires a configured model and must be supported by its Model Catalog entry",
				path: ["thinkingLevel"],
			});
		}
	});

type AgentScope = "package" | "user" | "project";

type AgentRoot = Readonly<{
	path: string;
	projectRoot?: string;
	scope: AgentScope;
}>;

type ParsedAgentFile = Readonly<{
	agent: PluginAgentRegistration;
	disabled: boolean;
}>;

export type SubagentDiscoveryResult = Readonly<{
	agents: readonly PluginAgentRegistration[];
	diagnostics: readonly string[];
}>;

export type DiscoverSubagentAgentsInput = Readonly<{
	trustedProjectRoots?: readonly string[];
	userDataDir: string;
	builtinRoot?: string;
}>;

const readDirectoryEntries = (directory: string): Promise<nodeFs.Dirent[]> =>
	fs.readdir(directory, { withFileTypes: true });

const markdownFilesUnder = async (root: string): Promise<string[]> => {
	const files: string[] = [];
	const visit = async (directory: string): Promise<void> => {
		let entries: nodeFs.Dirent[];
		try {
			entries = await readDirectoryEntries(directory);
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				return;
			}
			throw error;
		}
		for (const entry of entries.toSorted((left, right) =>
			left.name.localeCompare(right.name)
		)) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(entryPath);
			} else if (entry.isFile() && path.extname(entry.name) === ".md") {
				files.push(entryPath);
			}
		}
	};
	await visit(root);
	return files;
};

const parseAgentFile = (
	contents: string,
	filePath: string,
	root: AgentRoot
): ParsedAgentFile => {
	const match = agentFilePattern.exec(contents);
	if (match === null) {
		throw new Error("Expected YAML frontmatter between --- delimiters.");
	}
	const frontmatter = agentFrontmatterSchema.safeParse(
		parseYaml(match[1] ?? "") as unknown
	);
	if (!frontmatter.success) {
		throw new Error(frontmatter.error.message);
	}
	const definition = frontmatter.data;
	const instructions = (match[2] ?? "").trim();
	if (
		(!definition.disabled && instructions.length === 0) ||
		instructions.length > MAX_AGENT_INSTRUCTIONS_LENGTH
	) {
		throw new Error(
			`Agent instructions must contain between 1 and ${MAX_AGENT_INSTRUCTIONS_LENGTH} characters.`
		);
	}
	return {
		agent: {
			agent: {
				description: definition.description,
				displayName: agentLabelFromId(definition.name),
				id: definition.name,
				instructions,
				role: definition.role ?? "subagent",
			},
			...(definition.model === undefined ? {} : { model: definition.model }),
			...(definition.thinkingLevel === undefined
				? {}
				: { thinkingLevel: definition.thinkingLevel }),
			...(definition.requiredTools === undefined
				? {}
				: { requiredTools: definition.requiredTools }),
			source: {
				path: filePath,
				...(root.projectRoot === undefined
					? {}
					: { projectRoot: root.projectRoot }),
				scope: root.scope,
			},
			...(definition.tools === undefined ? {} : { tools: definition.tools }),
		},
		disabled: definition.disabled ?? false,
	};
};

const agentRoots = ({
	builtinRoot,
	trustedProjectRoots,
	userDataDir,
}: DiscoverSubagentAgentsInput): readonly AgentRoot[] => [
	{
		path: builtinRoot ?? path.resolve(import.meta.dir, "../agents"),
		scope: "package",
	},
	{ path: path.join(userDataDir, "agents"), scope: "user" },
	...(trustedProjectRoots ?? []).map((projectRoot) => ({
		path: path.join(projectRoot, ".wincode", "agents"),
		projectRoot,
		scope: "project" as const,
	})),
];

/** Discovers Markdown agent definitions; later roots override earlier names. */
export const discoverSubagentAgents = async (
	input: DiscoverSubagentAgentsInput
): Promise<SubagentDiscoveryResult> => {
	const agentsById = new Map<string, ParsedAgentFile>();
	const diagnostics: string[] = [];
	for (const root of agentRoots(input)) {
		let files: string[];
		try {
			files = await markdownFilesUnder(root.path);
		} catch (error) {
			diagnostics.push(
				`Could not scan ${root.scope} agent directory '${root.path}': ${getErrorMessage(error, String(error))}`
			);
			continue;
		}
		for (const filePath of files) {
			try {
				const parsed = parseAgentFile(
					await readUtf8File(filePath),
					filePath,
					root
				);
				const current = agentsById.get(parsed.agent.agent.id);
				if (
					current !== undefined &&
					current.agent.source.scope === root.scope
				) {
					diagnostics.push(
						`Duplicate ${root.scope} Agent '${parsed.agent.agent.id}' in '${filePath}'; the lexically later file takes precedence.`
					);
				}
				agentsById.set(parsed.agent.agent.id, parsed);
			} catch (error) {
				diagnostics.push(
					`Ignored invalid Agent file '${filePath}': ${getErrorMessage(error, String(error))}`
				);
			}
		}
	}
	return {
		agents: [...agentsById.values()]
			.filter(({ disabled }) => !disabled)
			.map(({ agent }) => agent),
		diagnostics,
	};
};
