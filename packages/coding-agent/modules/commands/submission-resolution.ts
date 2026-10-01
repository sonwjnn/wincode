import { getErrorMessage } from "@wincode/runtime-utils";
import { expandCustomCommandTemplate } from "@/modules/commands/custom/expand";
import { parseCustomCommandInvocation } from "@/modules/commands/custom/invocation";
import type { CustomCommandSpec } from "@/modules/commands/custom/types";
import {
	hasSkillNamespace,
	parseSkillInvocation,
	SKILL_NAMESPACE_PREFIX,
	type Skill,
	type SkillContext,
} from "@/modules/skills";

export type SubmissionPromptSkillInvocation = {
	arguments?: string;
	name: string;
};

export type SubmissionPromptResolution =
	| {
			readonly kind: "ready";
			readonly text: string;
			readonly skill?: SkillContext;
	  }
	| { readonly kind: "rejected"; readonly reason: string };

export type ResolveSubmissionPromptInput = {
	discoverCustomCommands: () => Promise<CustomCommandSpec[]>;
	discoverSkills: () => Promise<Skill[]>;
	skillInvocation?: SubmissionPromptSkillInvocation;
	text: string;
	visibleText?: string;
};

const resolveSkill = async (
	invocation: SubmissionPromptSkillInvocation,
	discoverSkills: ResolveSubmissionPromptInput["discoverSkills"]
): Promise<SkillContext | undefined> => {
	const skills = await discoverSkills();
	const requestedName = invocation.name.toLowerCase();
	const skill = skills.find(({ name }) => name.toLowerCase() === requestedName);
	if (skill === undefined) {
		return;
	}
	return {
		arguments: invocation.arguments ?? "",
		instructions: skill.body,
		name: skill.name,
	};
};
const MAX_SUBMISSION_ERROR_LENGTH = 256;

const rejectedSubmissionPrompt = (
	reason: string
): SubmissionPromptResolution => ({
	kind: "rejected",
	reason:
		reason.length > MAX_SUBMISSION_ERROR_LENGTH
			? `${reason.slice(0, MAX_SUBMISSION_ERROR_LENGTH - 1)}…`
			: reason,
});

/** Resolves shared Skill and Custom Command intent before transport admission. */
export const resolveSubmissionPrompt = async ({
	discoverCustomCommands,
	discoverSkills,
	skillInvocation,
	text,
	visibleText = text,
}: ResolveSubmissionPromptInput): Promise<SubmissionPromptResolution> => {
	try {
		const parsedSkillInvocation = skillInvocation ?? parseSkillInvocation(text);
		if (skillInvocation !== undefined || hasSkillNamespace(text)) {
			if (parsedSkillInvocation === null) {
				return rejectedSubmissionPrompt(
					`Invalid skill invocation "${visibleText.trim()}".`
				);
			}
			const skill = await resolveSkill(parsedSkillInvocation, discoverSkills);
			if (skill === undefined) {
				return rejectedSubmissionPrompt(
					`Unknown skill "/${SKILL_NAMESPACE_PREFIX}${parsedSkillInvocation.name}".`
				);
			}
			return { kind: "ready", skill, text };
		}

		const invocation = parseCustomCommandInvocation(text);
		if (invocation === null) {
			return { kind: "ready", text };
		}
		const commands = await discoverCustomCommands();
		const command = commands.find(({ name }) => name === invocation.name);
		return {
			kind: "ready",
			text:
				command === undefined
					? text
					: expandCustomCommandTemplate(command.template, invocation.arguments),
		};
	} catch (error) {
		return rejectedSubmissionPrompt(getErrorMessage(error, String(error)));
	}
};
