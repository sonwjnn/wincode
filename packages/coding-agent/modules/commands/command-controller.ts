import type { CustomCommandSpec } from "@/modules/commands/custom/types";
import type { Skill, SkillContext } from "@/modules/skills";
import { SKILL_NAMESPACE_PREFIX } from "@/modules/skills";
import { findBuiltinCommand } from "./builtin-invocation";
import {
	type CommandItem,
	createSkillCommandSpecs,
	createSkillSearchCommandSpec,
	filterCommandItems,
	getCommandInvocation,
	getCommandLabel,
} from "./command-item";
import {
	type CommandCapability,
	type CommandSpec,
	getVisibleCommands,
} from "./commands";
import { resolveSubmissionPrompt } from "./submission-resolution";

declare const commandSuggestionIdBrand: unique symbol;

export type CommandSuggestionId = string & {
	readonly [commandSuggestionIdBrand]: true;
};

export type CommandSuggestion = {
	description: string;
	id: CommandSuggestionId;
	label: string;
};

export type CommandSuggestions = {
	allItems: readonly CommandSuggestion[];
	items: readonly CommandSuggestion[];
};

export type CommandSelection =
	| { kind: "insert"; invocation: string; reopen: boolean }
	| { execute: () => Promise<void>; kind: "execute" };

export type CommandPrompt = {
	text: string;
	skill?: SkillContext;
};

export type CommandPromptSubmit = (
	prompt: CommandPrompt
) => boolean | Promise<boolean> | void | Promise<void>;

export type CommandSubmissionPlan = {
	accept: (submit: CommandPromptSubmit) => Promise<boolean>;
	execute: () => Promise<void>;
};

export type CommandSubmissionInput = {
	hasAttachments: boolean;
	text: string;
	visibleText: string;
};

export type CommandController = {
	getSuggestions: (query: string) => CommandSuggestions;
	prepareSubmission: (
		input: CommandSubmissionInput
	) => Promise<CommandSubmissionPlan | undefined>;
	select: (
		id: CommandSuggestionId,
		source: "enter" | "tab"
	) => CommandSelection | undefined;
};

export type CommandControllerOptions = {
	unavailableCapabilities?: readonly CommandCapability[];
	onCompact?: (focus?: string) => Promise<boolean> | boolean;
	onError: (message: string) => void;
	onOpenSettings?: (section?: string) => Promise<void> | void;
};

/** Creates a controller bound to the current view's supported actions. */
export type CommandControllerFactory = {
	create: (options: CommandControllerOptions) => CommandController;
};

export type CreateCommandControllerOptions = {
	customCommands: readonly CustomCommandSpec[];
	discoverCustomCommands: () => Promise<CustomCommandSpec[]>;
	discoverSkills: () => Promise<Skill[]>;
	executeCommand: (command: CommandSpec) => void | Promise<void>;
	unavailableCapabilities?: readonly CommandCapability[];
	onError: (message: string) => void;
	skills: readonly Skill[];
};

const getSuggestionId = (item: CommandItem): CommandSuggestionId =>
	`${item.kind}:${item.value}` as CommandSuggestionId;

const toSuggestion = (item: CommandItem): CommandSuggestion => ({
	description: item.description,
	id: getSuggestionId(item),
	label: getCommandLabel(item),
});

/**
 * Owns slash-command discovery, matching, selection, and submission intent.
 * Input surfaces only render the suggestions and apply the returned plans.
 */
export function createCommandController(
	options: CreateCommandControllerOptions
): CommandController {
	const skills = createSkillCommandSpecs(options.skills);
	const baseCommands: CommandItem[] = [
		...getVisibleCommands({
			unavailableCapabilities: options.unavailableCapabilities,
		}),
		...options.customCommands,
	];
	const skillSearch =
		skills.length > 0 ? createSkillSearchCommandSpec(skills.length) : undefined;
	const allSuggestions = [
		...(skillSearch === undefined ? [] : [skillSearch]),
		...baseCommands,
		...skills,
	];
	const itemById = new Map(
		allSuggestions.map((item) => [getSuggestionId(item), item])
	);

	return {
		getSuggestions(query) {
			const normalizedQuery = query.toLowerCase();
			const isSkillSearch = normalizedQuery.startsWith(SKILL_NAMESPACE_PREFIX);
			const isBareSkillSearch =
				normalizedQuery.length > 0 &&
				normalizedQuery !== SKILL_NAMESPACE_PREFIX.slice(0, -1);
			const candidates = isSkillSearch
				? skills
				: [
						...(skillSearch === undefined ? [] : [skillSearch]),
						...baseCommands,
						...(isBareSkillSearch ? skills : []),
					];
			const matches = filterCommandItems(candidates, query);
			return {
				allItems: candidates.map(toSuggestion),
				items: matches.map(toSuggestion),
			};
		},
		async prepareSubmission(input) {
			if (input.text.length === 0 && !input.hasAttachments) {
				return;
			}

			const builtin = input.hasAttachments
				? null
				: findBuiltinCommand(input.text);
			if (builtin) {
				return {
					accept: async () => true,
					execute: async () => {
						await options.executeCommand(builtin);
					},
				};
			}

			const resolution = await resolveSubmissionPrompt({
				discoverCustomCommands: options.discoverCustomCommands,
				discoverSkills: options.discoverSkills,
				text: input.text,
				visibleText: input.visibleText,
			});
			if (resolution.kind === "rejected") {
				options.onError(resolution.reason);
				return;
			}

			const prompt: CommandPrompt = {
				text: resolution.text,
				...(resolution.skill === undefined ? {} : { skill: resolution.skill }),
			};
			return {
				accept: async (submit) => (await submit(prompt)) !== false,
				execute: async () => undefined,
			};
		},
		select(id, source) {
			const item = itemById.get(id);
			if (!item) {
				return;
			}

			if (item.kind === "skill-search") {
				return {
					kind: "insert",
					invocation: getCommandInvocation(item),
					reopen: true,
				};
			}
			if (
				item.kind === "custom" ||
				item.kind === "skill" ||
				(source === "tab" &&
					item.kind === "builtin" &&
					item.input.kind !== "none")
			) {
				return {
					kind: "insert",
					invocation: getCommandInvocation(item),
					reopen: false,
				};
			}
			if (item.kind === "builtin") {
				return {
					execute: async () => {
						await options.executeCommand(item);
					},
					kind: "execute",
				};
			}
		},
	};
}
