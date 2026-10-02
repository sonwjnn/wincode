import { describe, expect, test } from "bun:test";
import {
	type CreateCommandControllerOptions,
	createCommandController,
} from "@/modules/commands/command-controller";
import type { CustomCommandSpec } from "@/modules/commands/custom/types";
import type { TrackedCommandSelection } from "@/modules/sessions/hooks/input-controller/selections";
import {
	preparePromptSubmission,
	type SubmitDependencies,
	type SubmitSnapshot,
} from "@/modules/sessions/hooks/input-controller/submit";
import type { Skill } from "@/modules/skills";

const TEST_SKILL: Skill = {
	body: "Review the implementation carefully.",
	description: "Reviews implementation",
	filePath: "/tmp/review/SKILL.md",
	name: "review",
	scope: "project",
};

const AUDIT_SKILL: Skill = {
	body: "Audit the dependency graph.",
	description: "Audits dependencies",
	filePath: "/tmp/audit/SKILL.md",
	name: "audit",
	scope: "project",
};

const TEST_CUSTOM_COMMAND: CustomCommandSpec = {
	description: "Commit with conventional commits",
	kind: "custom",
	name: "git-commit",
	template: "Commit the staged changes with a conventional message.",
	value: "/git-commit",
};

const emptySnapshot = (): SubmitSnapshot => ({
	fileTokens: [],
	files: [],
	pastedTexts: [],
	rawText: "",
});

const selection = (
	kind: TrackedCommandSelection["kind"],
	name: string,
	marker: string,
	start: number
): TrackedCommandSelection => ({
	end: start + marker.length,
	kind,
	marker,
	name,
	start,
});

type SubmitOverrides = {
	disabled?: boolean;
	discoverCustomCommands?: CreateCommandControllerOptions["discoverCustomCommands"];
	discoverSkills?: CreateCommandControllerOptions["discoverSkills"];
	executeCommand?: CreateCommandControllerOptions["executeCommand"];
	onError?: CreateCommandControllerOptions["onError"];
	onSubmit?: SubmitDependencies["onSubmit"];
	selections?: readonly TrackedCommandSelection[];
};

const createDependencies = (
	overrides: SubmitOverrides = {}
): SubmitDependencies => ({
	commandController: createCommandController({
		customCommands: [],
		discoverCustomCommands:
			overrides.discoverCustomCommands ?? (async () => []),
		discoverSkills: overrides.discoverSkills ?? (async () => []),
		executeCommand: overrides.executeCommand ?? (() => undefined),
		onError: overrides.onError ?? (() => undefined),
		skills: [],
	}),
	disabled: overrides.disabled ?? false,
	onSubmit: overrides.onSubmit ?? (() => undefined),
	selections: overrides.selections ?? [],
});

const submitPrompt = async (
	dependencies: SubmitDependencies,
	snapshot: SubmitSnapshot
): Promise<boolean> => {
	const prepared = await preparePromptSubmission(dependencies, snapshot);
	if (prepared.accepted) {
		await prepared.execute();
	}
	return prepared.accepted;
};

describe("preparePromptSubmission", () => {
	test("sends typed command lookalikes as literal prompt text", async () => {
		const submissions: Array<{ skill?: unknown; text: string }> = [];
		const accepted = await submitPrompt(
			createDependencies({
				discoverCustomCommands: async () => [TEST_CUSTOM_COMMAND],
				discoverSkills: async () => [TEST_SKILL],
				onSubmit: (submission) => {
					submissions.push({
						...("skill" in submission && submission.skill !== undefined
							? { skill: submission.skill }
							: {}),
						text: submission.text,
					});
				},
			}),
			{ ...emptySnapshot(), rawText: "/skill:review focus on auth" }
		);

		expect(accepted).toBe(true);
		expect(submissions).toEqual([{ text: "/skill:review focus on auth" }]);
	});

	test("activates the leftmost selected Skill and strips every selected marker", async () => {
		const rawText = "please /skill:audit and /skill:review now";
		const auditAt = rawText.indexOf("/skill:audit");
		const reviewAt = rawText.indexOf("/skill:review");
		const submissions: Array<{ skill?: unknown; text: string }> = [];
		const accepted = await submitPrompt(
			createDependencies({
				discoverSkills: async () => [TEST_SKILL, AUDIT_SKILL],
				onSubmit: (submission) => {
					submissions.push({
						...(submission.skill === undefined
							? {}
							: { skill: submission.skill }),
						text: submission.text,
					});
				},
				selections: [
					selection("skill", "audit", "/skill:audit", auditAt),
					selection("skill", "review", "/skill:review", reviewAt),
				],
			}),
			{ ...emptySnapshot(), rawText }
		);

		expect(accepted).toBe(true);
		expect(submissions).toEqual([
			{
				skill: { instructions: AUDIT_SKILL.body, name: "audit" },
				text: "please and now",
			},
		]);
	});

	test("rejects the submission when any selected Skill is unknown", async () => {
		const errors: string[] = [];
		let calls = 0;
		const rawText = "/skill:review then /skill:missing";
		const accepted = await submitPrompt(
			createDependencies({
				discoverSkills: async () => [TEST_SKILL],
				onError: (message) => {
					errors.push(message);
				},
				onSubmit: () => {
					calls += 1;
					return true;
				},
				selections: [
					selection("skill", "review", "/skill:review", 0),
					selection(
						"skill",
						"missing",
						"/skill:missing",
						rawText.indexOf("/skill:missing")
					),
				],
			}),
			{ ...emptySnapshot(), rawText }
		);

		expect(accepted).toBe(false);
		expect(errors).toEqual(['Unknown skill "/skill:missing".']);
		expect(calls).toBe(0);
	});

	test("drops a selection whose marker the user edited", async () => {
		const submissions: Array<{ skill?: unknown; text: string }> = [];
		const accepted = await submitPrompt(
			createDependencies({
				discoverSkills: async () => [TEST_SKILL],
				onSubmit: (submission) => {
					submissions.push({
						...(submission.skill === undefined
							? {}
							: { skill: submission.skill }),
						text: submission.text,
					});
				},
				// The tracked range points at a marker the user since edited.
				selections: [
					{
						end: 13,
						kind: "skill",
						marker: "/skill:review",
						name: "review",
						start: 0,
					},
				],
			}),
			{ ...emptySnapshot(), rawText: "/skil:review do it" }
		);

		expect(accepted).toBe(true);
		expect(submissions).toEqual([{ text: "/skil:review do it" }]);
	});

	test("expands a selected Custom Command with the text that follows it", async () => {
		const seen: string[] = [];
		const accepted = await submitPrompt(
			createDependencies({
				discoverCustomCommands: async () => [TEST_CUSTOM_COMMAND],
				onSubmit: (submission) => {
					seen.push(submission.text);
				},
				selections: [selection("custom", "git-commit", "/git-commit", 0)],
			}),
			{ ...emptySnapshot(), rawText: "/git-commit staged files" }
		);

		expect(accepted).toBe(true);
		expect(seen).toEqual([
			"Commit the staged changes with a conventional message.",
		]);
	});

	test("executes a selected Built-in with the text that follows it", async () => {
		const executed: Array<{ argument?: string; name: string }> = [];
		let submissions = 0;
		const accepted = await submitPrompt(
			createDependencies({
				executeCommand: (command) => {
					executed.push({
						name: command.name,
						...("argument" in command && command.argument !== undefined
							? { argument: command.argument }
							: {}),
					});
				},
				onSubmit: () => {
					submissions += 1;
					return true;
				},
				selections: [selection("builtin", "compact", "/compact", 0)],
			}),
			{ ...emptySnapshot(), rawText: "/compact preserve decisions" }
		);

		expect(accepted).toBe(true);
		expect(executed).toEqual([
			{ argument: "preserve decisions", name: "compact" },
		]);
		expect(submissions).toBe(0);
	});

	test("expands pasted-text markers before matching a selected marker", async () => {
		const token = "[Pasted ~2 lines]";
		const rawText = `/skill:review ${token}`;
		const start = rawText.indexOf(token);
		const submissions: Array<{ skill?: unknown; text: string }> = [];
		const accepted = await submitPrompt(
			createDependencies({
				discoverSkills: async () => [TEST_SKILL],
				onSubmit: (submission) => {
					submissions.push({
						...(submission.skill === undefined
							? {}
							: { skill: submission.skill }),
						text: submission.text,
					});
				},
				selections: [selection("skill", "review", "/skill:review", 0)],
			}),
			{
				...emptySnapshot(),
				pastedTexts: [
					{
						end: start + token.length,
						start,
						text: "focus on auth",
						token,
					},
				],
				rawText,
			}
		);

		expect(accepted).toBe(true);
		expect(submissions).toEqual([
			{
				skill: { instructions: TEST_SKILL.body, name: "review" },
				text: "focus on auth",
			},
		]);
	});

	test("carries the visible composition into the submission", async () => {
		const submissions: Array<{
			composition?: unknown;
			files: SubmitSnapshot["files"];
			text: string;
		}> = [];
		const files = [
			{
				filename: "clipboard.png",
				mediaType: "image/png",
				type: "file" as const,
				url: "data:image/png;base64,AAAA",
			},
		];

		const accepted = await submitPrompt(
			createDependencies({
				onSubmit: (submission) => {
					submissions.push(submission);
				},
			}),
			{
				fileTokens: [{ start: 0, token: "[Image 1]" }],
				files,
				pastedTexts: [
					{
						end: 27,
						start: 10,
						text: "first line\nsecond line",
						token: "[Pasted ~2 lines]",
					},
				],
				rawText: "[Image 1] [Pasted ~2 lines] explain",
			}
		);

		expect(accepted).toBe(true);
		// The turn runs the expanded prompt; the composition keeps the markers,
		// the attachments, and the pasted text, so a Recall restores what the
		// composer showed.
		expect(submissions[0]?.text).toBe(
			"[Image 1] first line\nsecond line explain"
		);
		expect(submissions[0]?.composition).toEqual({
			fileTokens: [{ start: 0, token: "[Image 1]" }],
			files,
			pastedText: [
				{ text: "first line\nsecond line", token: "[Pasted ~2 lines]" },
			],
			text: "[Image 1] [Pasted ~2 lines] explain",
		});
	});

	test("expands tracked pasted-text tokens before transport", async () => {
		const seen: string[] = [];
		const accepted = await submitPrompt(
			createDependencies({
				onSubmit: (submission) => {
					seen.push(submission.text);
					return;
				},
			}),
			{
				...emptySnapshot(),
				pastedTexts: [
					{
						end: 17,
						start: 0,
						text: "line one\nline two\nline three",
						token: "[Pasted ~3 lines]",
					},
				],
				rawText: "[Pasted ~3 lines] summarize",
			}
		);

		expect(seen).toEqual(["line one\nline two\nline three summarize"]);
		expect(accepted).toBe(true);
	});

	test("expands tracked pasted-text tokens at their untrimmed offsets", async () => {
		const seen: string[] = [];
		const token = "[Pasted ~2 lines]";
		const rawText = `  ${token} summarize`;
		const start = rawText.indexOf(token);
		const accepted = await submitPrompt(
			createDependencies({
				onSubmit: (submission) => {
					seen.push(submission.text);
				},
			}),
			{
				...emptySnapshot(),
				pastedTexts: [
					{
						end: start + token.length,
						start,
						text: "line one\nline two",
						token,
					},
				],
				rawText,
			}
		);

		expect(seen).toEqual(["line one\nline two summarize"]);
		expect(accepted).toBe(true);
	});

	test("maps a selected marker through pasted-text expansion", async () => {
		const token = "[Pasted ~2 lines]";
		const rawText = `  ${token} /skill:review`;
		const start = rawText.indexOf(token);
		const seen: Array<{ skill?: unknown; text: string }> = [];
		const accepted = await submitPrompt(
			createDependencies({
				discoverSkills: async () => [TEST_SKILL],
				onSubmit: (submission) => {
					seen.push({
						...(submission.skill === undefined
							? {}
							: { skill: submission.skill }),
						text: submission.text,
					});
				},
				selections: [
					selection(
						"skill",
						"review",
						"/skill:review",
						rawText.indexOf("/skill:review")
					),
				],
			}),
			{
				...emptySnapshot(),
				pastedTexts: [
					{
						end: start + token.length,
						start,
						text: "line one\nline two",
						token,
					},
				],
				rawText,
			}
		);

		expect(accepted).toBe(true);
		expect(seen).toEqual([
			{
				skill: { instructions: TEST_SKILL.body, name: "review" },
				text: "line one\nline two",
			},
		]);
	});

	test("rejects empty submissions without calling the transport", async () => {
		let calls = 0;
		const accepted = await submitPrompt(
			createDependencies({
				onSubmit: () => {
					calls += 1;
					return true;
				},
			}),
			emptySnapshot()
		);

		expect(accepted).toBe(false);
		expect(calls).toBe(0);
	});

	test("submits image-only prompts with no text", async () => {
		const file = {
			filename: "clipboard",
			mediaType: "image/png",
			type: "file" as const,
			url: "data:image/png;base64,aGVsbG8=",
		};
		const seen: Array<{ files: SubmitSnapshot["files"]; text: string }> = [];
		const accepted = await submitPrompt(
			createDependencies({
				onSubmit: (submission) => {
					seen.push({ files: submission.files, text: submission.text });
					return true;
				},
			}),
			{ ...emptySnapshot(), files: [file], rawText: "" }
		);

		expect(seen).toEqual([{ files: [file], text: "" }]);
		expect(accepted).toBe(true);
	});

	test("keeps the composition when the transport rejects", async () => {
		const accepted = await submitPrompt(
			createDependencies({
				onSubmit: () => false,
			}),
			{ ...emptySnapshot(), rawText: "keep me" }
		);

		expect(accepted).toBe(false);
	});

	test("treats a void transport result as acceptance", async () => {
		const accepted = await submitPrompt(
			createDependencies({
				onSubmit: () => undefined,
			}),
			{ ...emptySnapshot(), rawText: "plain prompt" }
		);

		expect(accepted).toBe(true);
	});

	test("does not submit while disabled", async () => {
		let calls = 0;
		const accepted = await submitPrompt(
			createDependencies({
				disabled: true,
				onSubmit: () => {
					calls += 1;
					return true;
				},
			}),
			{ ...emptySnapshot(), rawText: "ignored" }
		);

		expect(accepted).toBe(false);
		expect(calls).toBe(0);
	});

	test("surfaces skill discovery failures through onError without submitting", async () => {
		const failure = new Error("Skill directory is unavailable");
		const errors: string[] = [];
		let calls = 0;
		const accepted = await submitPrompt(
			createDependencies({
				discoverSkills: async () => {
					throw failure;
				},
				onError: (message) => {
					errors.push(message);
				},
				onSubmit: () => {
					calls += 1;
					return true;
				},
				selections: [selection("skill", "review", "/skill:review", 0)],
			}),
			{ ...emptySnapshot(), rawText: "/skill:review" }
		);

		expect(accepted).toBe(false);
		expect(errors).toEqual([failure.message]);
		expect(calls).toBe(0);
	});
});
