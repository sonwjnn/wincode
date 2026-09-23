import { getErrorMessage, isNull } from "@wincode/runtime-utils";
import type { Skill, SkillContext } from "@wincode/skills";
import {
	hasSkillNamespace,
	parseSkillInvocation,
	SKILL_NAMESPACE_PREFIX,
} from "@wincode/skills";
import type { CommandSpec } from "@/modules/commands/commands";
import { expandCustomCommandTemplate } from "@/modules/custom-commands/expand";
import { parseCustomCommandInvocation } from "@/modules/custom-commands/invocation";
import type { CustomCommandSpec } from "@/modules/custom-commands/types";
import type { SessionFilePart } from "@/modules/sessions/message";
import type { ChatPromptSubmission } from "../../utils";
import { findBuiltinCommand } from "./builtin-command";

type SkillPrompt = {
	skill?: SkillContext;
	text: string;
};

type DiscoverSkills = () => Promise<Skill[]>;

/**
 * Steering Messages are text-only: the running Agent Turn's Steering Lane
 * refuses anything the turn cannot safely take mid-flight.
 */
const STEERING_ATTACHMENT_ERROR =
	"Attachments cannot join a running Agent Turn.";
const STEERING_SKILL_ERROR = "A Skill cannot be invoked on a Steering Message.";
const STEERING_COMMAND_ERROR =
	"A Custom Command cannot be invoked on a Steering Message.";

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
	files: SessionFilePart[];
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
	/**
	 * True while the composer submits into the running Agent Turn's
	 * Steering Lane.
	 */
	steering?: boolean;
};

/**
 * The Built-in Command one composition invokes, or null when the line is
 * ordinary prompt text. Pasted-text markers are expanded first, so a focus
 * pasted after `/compact ` reaches the command as the pasted content, and a
 * composition carrying attachments stays a prompt.
 */
export const resolveBuiltinCommand = (
	snapshot: SubmitSnapshot
): CommandSpec | null =>
	snapshot.files.length === 0
		? findBuiltinCommand(
				expandTrackedPastedText(snapshot.rawText, snapshot.pastedTexts)
			)
		: null;

export const resolveSkillPrompt = async (
	text: string,
	discover: DiscoverSkills,
	visibleText = text
): Promise<SkillPrompt> => {
	const invocation = parseSkillInvocation(text);
	if (!invocation) {
		return { text };
	}

	const requested = invocation.name.toLowerCase();
	const skills = await discover();
	const skill = skills.find(({ name }) => name.toLowerCase() === requested);
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
 * The reserved `skill:` namespace reports its own failures: text that claims it
 * never reaches the transport as ordinary prompt text.
 */
const describeSkillInvocationFailure = (
	text: string,
	visibleText: string
): string => {
	const invocation = parseSkillInvocation(text);
	return invocation
		? `Unknown skill "/${SKILL_NAMESPACE_PREFIX}${invocation.name}".`
		: `Invalid skill invocation "${visibleText.trim()}".`;
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
		if (hasSkillNamespace(text)) {
			const skillPrompt = await resolveSkillPrompt(
				text,
				dependencies.discoverSkills,
				visibleText
			);
			if (skillPrompt.skill) {
				return skillPrompt;
			}
			dependencies.onError(describeSkillInvocationFailure(text, visibleText));
			return null;
		}
		return resolveCustomCommandPrompt(
			text,
			dependencies.discoverCustomCommands
		);
	} catch (error) {
		dependencies.onError(getErrorMessage(error, String(error)));
		return null;
	}
};

/**
 * The single submit seam: expand, resolve skill/custom-command intent, hand the
 * submission to the transport, and report whether it was accepted. History
 * recording and state reset live with the caller (the input controller hook)
 * and run only on acceptance. A Steering Message is text-only: attachments,
 * Skill intent, and Custom Command intent are refused before the transport sees
 * the submission.
 */
export async function submitPrompt(
	dependencies: SubmitDependencies,
	snapshot: SubmitSnapshot
): Promise<boolean> {
	if (dependencies.disabled) {
		return false;
	}

	const { files, fileTokens, pastedTexts, rawText } = snapshot;
	const visibleText = rawText.trim();
	// Markers carry offsets into the untrimmed composition, so expand before
	// trimming or a leading space shifts every replacement.
	const text = expandTrackedPastedText(rawText, pastedTexts).trim();
	if (!text && files.length === 0) {
		return false;
	}

	if (dependencies.steering) {
		if (files.length > 0) {
			dependencies.onError(STEERING_ATTACHMENT_ERROR);
			return false;
		}
		if (hasSkillNamespace(text)) {
			dependencies.onError(STEERING_SKILL_ERROR);
			return false;
		}
		const invocation = parseCustomCommandInvocation(text);
		if (invocation) {
			let commands: CustomCommandSpec[];
			try {
				commands = await dependencies.discoverCustomCommands();
			} catch (error) {
				dependencies.onError(getErrorMessage(error, String(error)));
				return false;
			}
			if (commands.some(({ name }) => name === invocation.name)) {
				dependencies.onError(STEERING_COMMAND_ERROR);
				return false;
			}
		}

		const accepted = await dependencies.onSubmit({
			composition: {
				fileTokens: [],
				files: [],
				pastedText: pastedTexts.map(({ text: pasted, token }) => ({
					text: pasted,
					token,
				})),
				text: visibleText,
			},
			files: [],
			text,
		});
		return accepted !== false;
	}

	const skillPrompt = await resolvePromptOrReportError(
		text,
		visibleText,
		dependencies
	);
	if (isNull(skillPrompt)) {
		return false;
	}

	const accepted = await dependencies.onSubmit({
		composition: {
			fileTokens,
			files,
			pastedText: pastedTexts.map(({ text, token }) => ({ text, token })),
			text: visibleText,
		},
		files,
		...skillPrompt,
	});
	return accepted !== false;
}
