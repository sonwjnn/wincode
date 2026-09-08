import { describe, expect, test } from "bun:test";
import type { Skill } from "@wincode/skills";
import type { CustomCommandSpec } from "@/modules/custom-commands/types";
import {
	resolveCustomCommandPrompt,
	resolveSkillPrompt,
	type SubmitDependencies,
	type SubmitSnapshot,
	submitPrompt,
} from "./submit";

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
			resolveSkillPrompt("/review focus on auth", async () => [TEST_SKILL])
		).resolves.toEqual({
			skill: {
				arguments: "focus on auth",
				instructions: TEST_SKILL.body,
				name: "review",
			},
			text: "/review focus on auth",
		});
	});

	test("accepts recognized zero-argument skill invocations", async () => {
		await expect(
			resolveSkillPrompt("/review", async () => [TEST_SKILL])
		).resolves.toEqual({
			skill: {
				arguments: "",
				instructions: TEST_SKILL.body,
				name: "review",
			},
			text: "/review",
		});
	});

	test("keeps visible pasted-text tokens while resolving expanded skill args", async () => {
		await expect(
			resolveSkillPrompt(
				"/review expanded pasted content",
				async () => [TEST_SKILL],
				"/review [Pasted Text 1]"
			)
		).resolves.toEqual({
			skill: {
				arguments: "expanded pasted content",
				instructions: TEST_SKILL.body,
				name: "review",
			},
			text: "/review [Pasted Text 1]",
		});
	});

	test("submits unknown slash text normally", async () => {
		await expect(
			resolveSkillPrompt("/unknown keep this", async () => [TEST_SKILL])
		).resolves.toEqual({ text: "/unknown keep this" });
	});

	test("surfaces skill discovery failures", async () => {
		const failure = new Error("Skill directory is unavailable");
		await expect(
			resolveSkillPrompt("/review", async () => {
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

describe("submitPrompt", () => {
	test("passes the visible skill command text to the transport", async () => {
		const onSubmit = (submission: {
			files: SubmitSnapshot["files"];
			skill?: unknown;
			text: string;
		}) => {
			expect(submission.text).toBe("/review focus on auth");
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
			{ ...emptySnapshot(), rawText: "/review focus on auth" }
		);

		expect(accepted).toBe(true);
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
			{ ...emptySnapshot(), rawText: "/review" }
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
