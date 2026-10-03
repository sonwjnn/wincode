import type { CustomCommandSpec } from "@/modules/commands/custom/types";
import type { Skill, SkillContext } from "@/modules/skills";
import { SKILL_NAMESPACE_PREFIX } from "@/modules/skills";
import {
	type CommandItem,
	createSkillCommandSpecs,
	createSkillSearchCommandSpec,
	filterCommandItems,
	getCommandInvocation,
	getCommandLabel,
} from "./command-item";
import {
	COMMANDS,
	type CommandCapability,
	type CommandSpec,
	getVisibleCommands,
	isOptionalTextCommand,
} from "./commands";
import {
	resolveSubmissionPrompt,
	type SubmissionIntent,
} from "./submission-resolution";

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

/**
 * Where the composer opened the command overlay: `root` at the start of an
 * empty prompt, `skill` on a `/` token inside prose.
 */
export type CommandSuggestionScope = "root" | "skill";

export type CommandSelectionIntent = Readonly<{
	kind: "builtin" | "custom" | "skill";
	name: string;
}>;

export type CommandSelection =
	| {
			kind: "insert";
			intent?: CommandSelectionIntent;
			invocation: string;
			reopen: boolean;
	  }
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
	intents: readonly SubmissionIntent[];
	text: string;
};

export type CommandController = {
	getSuggestions: (
		query: string,
		scope?: CommandSuggestionScope
	) => CommandSuggestions;
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

const itemIntent = (item: CommandItem): CommandSelectionIntent | undefined =>
	item.kind === "skill-search"
		? undefined
		: { kind: item.kind, name: item.name };

/** Resolves the tracked Built-in selection into its command spec. */
const builtinFromIntent = (
	intent: SubmissionIntent,
	text: string
): CommandSpec | undefined => {
	const spec: CommandSpec | undefined = COMMANDS.find(
		(command) => command.name === intent.name
	);
	if (spec === undefined || !isOptionalTextCommand(spec)) {
		return spec;
	}
	const argument =
		intent.end === undefined ? "" : text.slice(intent.end).trim();
	return argument ? { ...spec, argument } : spec;
};

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
		getSuggestions(query, scope = "root") {
			if (scope === "skill") {
				return {
					allItems: skills.map(toSuggestion),
					items: filterCommandItems(skills, query).map(toSuggestion),
				};
			}

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
			return {
				allItems: candidates.map(toSuggestion),
				items: filterCommandItems(candidates, query).map(toSuggestion),
			};
		},
		async prepareSubmission(input) {
			if (
				input.text.length === 0 &&
				!input.hasAttachments &&
				input.intents.length === 0
			) {
				return;
			}

			// A selected Built-in runs independently: its trailing text becomes
			// the command argument, and co-selected Skill or Custom Command
			// intents are not resolved or stripped. Attachments ride along with
			// the composer, not with the command, exactly like a selected
			// Built-in whose input capability is `none`.
			const builtinIntent = input.intents.find(
				(intent) => intent.kind === "builtin"
			);
			const builtin =
				builtinIntent === undefined
					? undefined
					: builtinFromIntent(builtinIntent, input.text);
			if (builtin !== undefined) {
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
				intents: input.intents,
				text: input.text,
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
				const intent = itemIntent(item);
				return {
					kind: "insert",
					...(intent === undefined ? {} : { intent }),
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
