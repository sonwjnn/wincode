import { describe, expect, test } from "bun:test";
import type { Skill } from "@wincode/skills";
import type { CustomCommandSpec } from "@/modules/custom-commands/types";
import {
	resolveBuiltinCommand,
	resolveCustomCommandPrompt,
	resolveSkillPrompt,
	type SubmitDependencies,
	type SubmitSnapshot,
	submitPrompt,
} from "@/modules/sessions/hooks/input-controller/submit";
import type { ChatPromptSubmission } from "@/modules/sessions/utils";

const TEST_SKILL: Skill = {
	body: "Review the implementation carefully.",
	description: "Reviews implementation",
	filePath: "/tmp/review/SKILL.md",
	name: "review",
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

const createDependencies = (
	overrides: Partial<SubmitDependencies> = {}
): SubmitDependencies => ({
	disabled: false,
	discoverCustomCommands: async () => [],
	discoverSkills: async () => [],
	onError: () => undefined,
	onSubmit: () => undefined,
	...overrides,
});

describe("resolveSkillPrompt", () => {
	test("resolves recognized skill invocations to request-scoped context", async () => {
		await expect(
			resolveSkillPrompt("/skill:review focus on auth", async () => [
				TEST_SKILL,
			])
		).resolves.toEqual({
			skill: {
				arguments: "focus on auth",
				instructions: TEST_SKILL.body,
				name: "review",
			},
			text: "/skill:review focus on auth",
		});
	});

	test("accepts recognized zero-argument skill invocations", async () => {
		await expect(
			resolveSkillPrompt("/skill:review", async () => [TEST_SKILL])
		).resolves.toEqual({
			skill: {
				arguments: "",
				instructions: TEST_SKILL.body,
				name: "review",
			},
			text: "/skill:review",
		});
	});

	test("resolves the namespace and name case-insensitively", async () => {
		await expect(
			resolveSkillPrompt("/SKILL:Review", async () => [TEST_SKILL])
		).resolves.toEqual({
			skill: {
				arguments: "",
				instructions: TEST_SKILL.body,
				name: "review",
			},
			text: "/SKILL:Review",
		});
	});

	test("keeps visible pasted-text tokens while resolving expanded skill args", async () => {
		await expect(
			resolveSkillPrompt(
				"/skill:review expanded pasted content",
				async () => [TEST_SKILL],
				"/skill:review [Pasted Text 1]"
			)
		).resolves.toEqual({
			skill: {
				arguments: "expanded pasted content",
				instructions: TEST_SKILL.body,
				name: "review",
			},
			text: "/skill:review [Pasted Text 1]",
		});
	});

	test("leaves a bare skill name as plain prompt text", async () => {
		await expect(
			resolveSkillPrompt("/review focus on auth", async () => [TEST_SKILL])
		).resolves.toEqual({ text: "/review focus on auth" });
	});

	test("submits unknown slash text normally", async () => {
		await expect(
			resolveSkillPrompt("/unknown keep this", async () => [TEST_SKILL])
		).resolves.toEqual({ text: "/unknown keep this" });
	});

	test("surfaces skill discovery failures", async () => {
		const failure = new Error("Skill directory is unavailable");
		await expect(
			resolveSkillPrompt("/skill:review", async () => {
				throw failure;
			})
		).rejects.toBe(failure);
	});
});

describe("resolveCustomCommandPrompt", () => {
	test("expands recognized custom command invocations into prompt text", async () => {
		await expect(
			resolveCustomCommandPrompt("/git-commit staged files", async () => [
				TEST_CUSTOM_COMMAND,
			])
		).resolves.toEqual({
			text: "Commit the staged changes with a conventional message.",
		});
	});

	test("accepts recognized zero-argument custom command invocations", async () => {
		await expect(
			resolveCustomCommandPrompt("/git-commit", async () => [
				TEST_CUSTOM_COMMAND,
			])
		).resolves.toEqual({
			text: "Commit the staged changes with a conventional message.",
		});
	});

	test("keeps unknown slash text as a plain prompt", async () => {
		await expect(
			resolveCustomCommandPrompt("/unknown keep this", async () => [
				TEST_CUSTOM_COMMAND,
			])
		).resolves.toEqual({ text: "/unknown keep this" });
	});

	test("surfaces custom command discovery failures", async () => {
		const failure = new Error("Command directory is unavailable");
		await expect(
			resolveCustomCommandPrompt("/git-commit", async () => {
				throw failure;
			})
		).rejects.toBe(failure);
	});
});

describe("resolveBuiltinCommand", () => {
	test("expands pasted-text markers before matching, so the focus is real text", () => {
		const token = "[Pasted ~2 lines]";
		const rawText = `/compact ${token}`;
		const start = rawText.indexOf(token);

		expect(
			resolveBuiltinCommand({
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
			})
		).toMatchObject({ focus: "line one\nline two", kind: "compact" });
	});

	test("keeps a composition carrying attachments a prompt", () => {
		expect(
			resolveBuiltinCommand({
				...emptySnapshot(),
				files: [
					{
						filename: "clipboard",
						mediaType: "image/png",
						type: "file",
						url: "data:image/png;base64,aGVsbG8=",
					},
				],
				rawText: "/models",
			})
		).toBeNull();
	});

	test("expands markers at their untrimmed offsets when the line is indented", () => {
		const token = "[Pasted ~2 lines]";
		const rawText = `  /compact ${token}`;
		const start = rawText.indexOf(token);

		expect(
			resolveBuiltinCommand({
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
			})
		).toMatchObject({ focus: "line one\nline two", kind: "compact" });
	});
});

describe("submitPrompt", () => {
	test("passes the visible skill command text to the transport", async () => {
		const onSubmit = (submission: {
			files: SubmitSnapshot["files"];
			skill?: unknown;
			text: string;
		}) => {
			expect(submission.text).toBe("/skill:review focus on auth");
			expect(submission.skill).toEqual({
				arguments: "focus on auth",
				instructions: TEST_SKILL.body,
				name: "review",
			});
			expect(submission.files).toEqual([]);
		};

		const accepted = await submitPrompt(
			createDependencies({
				discoverSkills: async () => [TEST_SKILL],
				onSubmit,
			}),
			{ ...emptySnapshot(), rawText: "/skill:review focus on auth" }
		);

		expect(accepted).toBe(true);
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

	test("reports an unknown skill instead of submitting its text", async () => {
		const errors: string[] = [];
		let calls = 0;
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
			}),
			{ ...emptySnapshot(), rawText: "/skill:missing focus" }
		);

		expect(accepted).toBe(false);
		expect(errors).toEqual(['Unknown skill "/skill:missing".']);
		expect(calls).toBe(0);
	});

	test("reports a malformed skill invocation instead of submitting its text", async () => {
		const errors: string[] = [];
		let calls = 0;
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
			}),
			{ ...emptySnapshot(), rawText: "/skill: review" }
		);

		expect(accepted).toBe(false);
		expect(errors).toEqual(['Invalid skill invocation "/skill: review".']);
		expect(calls).toBe(0);
	});

	test("routes a bare name to the custom command and the namespace to the skill", async () => {
		const customReview: CustomCommandSpec = {
			description: "Local review template",
			kind: "custom",
			name: "review",
			template: "Review with the project checklist.",
			value: "/review",
		};
		const seen: string[] = [];
		const dependencies = createDependencies({
			discoverCustomCommands: async () => [customReview],
			discoverSkills: async () => [TEST_SKILL],
			onSubmit: (submission) => {
				seen.push(submission.text);
			},
		});

		await submitPrompt(dependencies, {
			...emptySnapshot(),
			rawText: "/review",
		});
		await submitPrompt(dependencies, {
			...emptySnapshot(),
			rawText: "/skill:review",
		});

		expect(seen).toEqual([
			"Review with the project checklist.",
			"/skill:review",
		]);
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
			}),
			{ ...emptySnapshot(), rawText: "/skill:review" }
		);

		expect(accepted).toBe(false);
		expect(errors).toEqual([failure.message]);
		expect(calls).toBe(0);
	});

	test("expands custom commands before transport", async () => {
		const seen: string[] = [];
		const accepted = await submitPrompt(
			createDependencies({
				discoverCustomCommands: async () => [TEST_CUSTOM_COMMAND],
				onSubmit: (submission) => {
					seen.push(submission.text);
					return;
				},
			}),
			{ ...emptySnapshot(), rawText: "/git-commit staged files" }
		);

		expect(seen).toEqual([
			"Commit the staged changes with a conventional message.",
		]);
		expect(accepted).toBe(true);
	});
});

describe("submitPrompt while steering a running Agent Turn", () => {
	const imageFile = {
		filename: "clipboard.png",
		mediaType: "image/png",
		type: "file" as const,
		url: "data:image/png;base64,AAAA",
	};

	test("refuses attachments instead of promising the turn a delivery it cannot pay for", async () => {
		const errors: string[] = [];
		const submissions: ChatPromptSubmission[] = [];

		const accepted = await submitPrompt(
			createDependencies({
				onError: (message) => errors.push(message),
				onSubmit: (submission) => {
					submissions.push(submission);
				},
				steering: true,
			}),
			{
				...emptySnapshot(),
				files: [imageFile],
				rawText: "[Image 1] keep going",
			}
		);

		expect(accepted).toBe(false);
		expect(errors).toEqual(["Attachments cannot join a running Agent Turn."]);
		expect(submissions).toEqual([]);
	});

	test("refuses a Skill invocation rather than arming a catalog inside the turn", async () => {
		const errors: string[] = [];

		const accepted = await submitPrompt(
			createDependencies({
				discoverSkills: async () => [TEST_SKILL],
				onError: (message) => errors.push(message),
				steering: true,
			}),
			{ ...emptySnapshot(), rawText: "/skill:review focus on auth" }
		);

		expect(accepted).toBe(false);
		expect(errors).toEqual([
			"A Skill cannot be invoked on a Steering Message.",
		]);
	});

	test("refuses a Custom Command invocation", async () => {
		const errors: string[] = [];

		const accepted = await submitPrompt(
			createDependencies({
				discoverCustomCommands: async () => [TEST_CUSTOM_COMMAND],
				onError: (message) => errors.push(message),
				steering: true,
			}),
			{ ...emptySnapshot(), rawText: "/git-commit" }
		);

		expect(accepted).toBe(false);
		expect(errors).toEqual([
			"A Custom Command cannot be invoked on a Steering Message.",
		]);
	});

	test("sends plain text with the composition it was written from", async () => {
		const submissions: ChatPromptSubmission[] = [];

		const accepted = await submitPrompt(
			createDependencies({
				discoverCustomCommands: async () => [TEST_CUSTOM_COMMAND],
				onSubmit: (submission) => {
					submissions.push(submission);
				},
				steering: true,
			}),
			{
				...emptySnapshot(),
				// A mention and an unknown slash word are ordinary text, not an
				// invocation: the message carries them literally.
				rawText: "use @src/index.ts and /unknown instead",
			}
		);

		expect(accepted).toBe(true);
		expect(submissions).toEqual([
			{
				composition: {
					files: [],
					fileTokens: [],
					pastedText: [],
					text: "use @src/index.ts and /unknown instead",
				},
				files: [],
				text: "use @src/index.ts and /unknown instead",
			},
		]);
	});
});
