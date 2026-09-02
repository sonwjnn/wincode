import type { FileUIPart } from "@wincode/ai/client";
import type { Skill, SkillContext } from "@wincode/skills";
import { parseSkillInvocation } from "@wincode/skills";
import { expandCustomCommandTemplate } from "@/modules/custom-commands/expand";
import { parseCustomCommandInvocation } from "@/modules/custom-commands/invocation";
import type { CustomCommandSpec } from "@/modules/custom-commands/types";
import type { ChatPromptSubmission } from "../../utils";

type SkillPrompt = {
	skill?: SkillContext;
	text: string;
};

type DiscoverSkills = () => Promise<Skill[]>;

const getErrorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export type TrackedPastedText = {
	end: number;
	start: number;
	text: string;
	token: string;
};

/** Expand extmark-backed markers without replacing literal lookalikes. */
const expandTrackedPastedText = (
	text: string,
	markers: readonly TrackedPastedText[]
): string =>
	markers
		.toSorted((left, right) => right.start - left.start)
		.reduce(
			(result, marker) =>
				result.slice(0, marker.start) + marker.text + result.slice(marker.end),
			text
		);

/** Everything the textarea knows about the composition at submit time. */
export type SubmitSnapshot = {
	files: FileUIPart[];
	fileTokens: Array<{ start: number; token: string }>;
	pastedTexts: readonly TrackedPastedText[];
	rawText: string;
};

export type SubmitDependencies = {
	disabled: boolean;
	discoverCustomCommands: () => Promise<CustomCommandSpec[]>;
	discoverSkills: () => Promise<Skill[]>;
	onError: (message: string) => void;
	onSubmit: (
		submission: ChatPromptSubmission
	) => boolean | Promise<boolean> | void | Promise<void>;
};

export const resolveSkillPrompt = async (
	text: string,
	discover: DiscoverSkills,
	visibleText = text
): Promise<SkillPrompt> => {
	const invocation = parseSkillInvocation(text);
	if (!invocation) {
		return { text };
	}

	const skills = await discover();
	const skill = skills.find(({ name }) => name === invocation.name);
	if (!skill) {
		return { text };
	}

	return {
		skill: {
			arguments: invocation.arguments,
			instructions: skill.body,
			name: skill.name,
		},
		text: visibleText,
	};
};

type DiscoverCustomCommands = () => Promise<CustomCommandSpec[]>;

export const resolveCustomCommandPrompt = async (
	text: string,
	discover: DiscoverCustomCommands
): Promise<SkillPrompt> => {
	const invocation = parseCustomCommandInvocation(text);
	if (!invocation) {
		return { text };
	}

	const commands = await discover();
	const command = commands.find(({ name }) => name === invocation.name);
	if (!command) {
		return { text };
	}

	return {
		text: expandCustomCommandTemplate(command.template, invocation.arguments),
	};
};

/**
 * Resolve skill/custom-command intent, or report the failure through onError
 * and return null — never throws.
 */
const resolvePromptOrReportError = async (
	text: string,
	visibleText: string,
	dependencies: SubmitDependencies
): Promise<SkillPrompt | null> => {
	try {
		const skillPrompt = await resolveSkillPrompt(
			text,
			dependencies.discoverSkills,
			visibleText
		);
		if (skillPrompt.skill) {
			return skillPrompt;
		}
		return resolveCustomCommandPrompt(
			skillPrompt.text,
			dependencies.discoverCustomCommands
		);
	} catch (error) {
		dependencies.onError(getErrorMessage(error));
		return null;
	}
};

/**
 * The single submit seam: expand, resolve skill/custom-command intent, hand the
 * submission to the transport, and report whether it was accepted. History
 * recording and state reset live with the caller (the input controller hook)
 * and run only on acceptance.
 */
export async function submitPrompt(
	dependencies: SubmitDependencies,
	snapshot: SubmitSnapshot
): Promise<boolean> {
	if (dependencies.disabled) {
		return false;
	}

	const { files, pastedTexts, rawText } = snapshot;
	const visibleText = rawText.trim();
	const text = expandTrackedPastedText(visibleText, pastedTexts);
	if (!text && files.length === 0) {
		return false;
	}

	const skillPrompt = await resolvePromptOrReportError(
		text,
		visibleText,
		dependencies
	);
	if (skillPrompt === null) {
		return false;
	}

	const accepted = await dependencies.onSubmit({ files, ...skillPrompt });
	return accepted !== false;
}
