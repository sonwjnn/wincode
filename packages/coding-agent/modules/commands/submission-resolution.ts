import { getErrorMessage } from "@wincode/runtime-utils";
import { expandCustomCommandTemplate } from "@/modules/commands/custom/expand";
import type { CustomCommandSpec } from "@/modules/commands/custom/types";
import type { Skill, SkillContext } from "@/modules/skills";

/**
 * One command or Skill selection a submission carries. The range is the
 * marker's span in the resolved prompt text; intents without a range come from
 * clients that activate a Skill by name instead of by composer selection.
 */
export type SubmissionIntent = Readonly<{
	end?: number;
	kind: "builtin" | "custom" | "skill";
	marker?: string;
	name: string;
	start?: number;
}>;

export type SubmissionPromptResolution =
	| {
			readonly kind: "ready";
			readonly skill?: SkillContext;
			readonly text: string;
	  }
	| { readonly kind: "rejected"; readonly reason: string };

export type ResolveSubmissionPromptInput = {
	discoverCustomCommands: () => Promise<CustomCommandSpec[]>;
	discoverSkills: () => Promise<Skill[]>;
	intents: readonly SubmissionIntent[];
	text: string;
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

type TextSpan = Readonly<{ end: number; start: number }>;

type RangedIntent = SubmissionIntent & {
	readonly end: number;
	readonly marker: string;
	readonly start: number;
};

const isRangedIntent = (intent: SubmissionIntent): intent is RangedIntent =>
	intent.start !== undefined &&
	intent.end !== undefined &&
	intent.marker !== undefined;

const WHITESPACE_PATTERN = /\s/u;

/**
 * The marker plus one neighbouring space, so stripping it leaves readable
 * prose instead of a double space. Adjacent or overlapping spans merge.
 */
const markerRemovals = (
	text: string,
	intents: readonly RangedIntent[]
): TextSpan[] => {
	const spans = intents
		.map(({ start, end }) => {
			const following = text[end] ?? "";
			const preceding = start > 0 ? (text[start - 1] ?? "") : "";
			if (WHITESPACE_PATTERN.test(following)) {
				return { end: end + 1, start };
			}
			if (WHITESPACE_PATTERN.test(preceding)) {
				return { end, start: start - 1 };
			}
			return { end, start };
		})
		.toSorted((left, right) => left.start - right.start);
	const merged: Array<{ end: number; start: number }> = [];
	for (const span of spans) {
		const previous = merged.at(-1);
		if (previous !== undefined && span.start <= previous.end) {
			merged[merged.length - 1] = {
				end: Math.max(previous.end, span.end),
				start: previous.start,
			};
		} else {
			merged.push(span);
		}
	}
	return merged;
};

const stripSpans = (text: string, spans: readonly TextSpan[]): string =>
	spans.reduceRight(
		(result, { start, end }) => result.slice(0, start) + result.slice(end),
		text
	);

/** Shifts an offset left by every removal that ends at or before it. */
const mapOffset = (offset: number, spans: readonly TextSpan[]): number =>
	spans.reduce(
		(mapped, { start, end }) =>
			end <= offset ? mapped - (end - start) : mapped,
		offset
	);

type LeftmostSkillResolution =
	| { readonly reason: string }
	| { readonly skill: SkillContext };

const resolveLeftmostSkill = async (
	intents: readonly SubmissionIntent[],
	discoverSkills: ResolveSubmissionPromptInput["discoverSkills"]
): Promise<LeftmostSkillResolution> => {
	const skills = await discoverSkills();
	const byName = new Map(
		skills.map((entry) => [entry.name.toLowerCase(), entry])
	);
	const resolved: Array<{ found: Skill; intent: SubmissionIntent }> = [];
	for (const intent of intents) {
		const found = byName.get(intent.name.toLowerCase());
		if (found === undefined) {
			return { reason: `Unknown skill "/skill:${intent.name}".` };
		}
		resolved.push({ found, intent });
	}
	const leftmost = resolved.reduce((first, entry) =>
		(first.intent.start ?? Number.MAX_SAFE_INTEGER) <=
		(entry.intent.start ?? Number.MAX_SAFE_INTEGER)
			? first
			: entry
	);
	return {
		skill: { instructions: leftmost.found.body, name: leftmost.found.name },
	};
};

/** Resolves selected Skill and Custom Command intent before transport admission. */
export const resolveSubmissionPrompt = async ({
	discoverCustomCommands,
	discoverSkills,
	intents,
	text,
}: ResolveSubmissionPromptInput): Promise<SubmissionPromptResolution> => {
	try {
		const skillIntents = intents.filter((intent) => intent.kind === "skill");
		const customIntent = intents.find((intent) => intent.kind === "custom");
		if (skillIntents.length === 0 && customIntent === undefined) {
			return { kind: "ready", text };
		}

		for (const intent of [...skillIntents, customIntent]) {
			if (
				intent !== undefined &&
				isRangedIntent(intent) &&
				text.slice(intent.start, intent.end) !== intent.marker
			) {
				return rejectedSubmissionPrompt(
					`The selected "/${intent.kind === "skill" ? `skill:${intent.name}` : intent.name}" is no longer in the prompt.`
				);
			}
		}

		let skill: SkillContext | undefined;
		if (skillIntents.length > 0) {
			const resolution = await resolveLeftmostSkill(
				skillIntents,
				discoverSkills
			);
			if ("reason" in resolution) {
				return rejectedSubmissionPrompt(resolution.reason);
			}
			skill = resolution.skill;
		}

		const removals = markerRemovals(text, skillIntents.filter(isRangedIntent));
		if (customIntent !== undefined) {
			const commands = await discoverCustomCommands();
			const command = commands.find(({ name }) => name === customIntent.name);
			if (command === undefined) {
				return rejectedSubmissionPrompt(
					`Unknown command "/${customIntent.name}".`
				);
			}
			const stripped = stripSpans(text, removals);
			// A ranged marker takes the text that follows it; a wire intent
			// carries its arguments as the submitted text itself.
			const argument = isRangedIntent(customIntent)
				? stripped.slice(mapOffset(customIntent.end, removals)).trim()
				: stripped.trim();
			return {
				kind: "ready",
				skill,
				text: expandCustomCommandTemplate(command.template, argument),
			};
		}

		return { kind: "ready", skill, text: stripSpans(text, removals).trim() };
	} catch (error) {
		return rejectedSubmissionPrompt(getErrorMessage(error, String(error)));
	}
};
