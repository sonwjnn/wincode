import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { CustomCommandSpec } from "@/modules/custom-commands/types";
import type { Skill } from "@/modules/skills";
import { CHAT_TEXT_AREA_KEY_BINDINGS } from "@/shared/providers/keyboard-layer/constants";
import {
	areFileMentionExtmarksCurrent,
	findImageTokenRanges,
	getImageToken,
	getNextImageLabel,
	isAttachmentTokenExtant,
	locateAttachmentTokens,
	mapOffsetThroughTextReplacement,
	normalizeFileTokensForTrimmedText,
} from "../../attachments";
import {
	resolveCustomCommandPrompt,
	resolveSkillPrompt,
} from "./chat-text-area";

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
const RESOLVE_SKILL_PROMPT_CALL =
	/resolveSkillPrompt\(\s*text,\s*discoverAvailableSkills,\s*visibleText\s*\)/;

describe("ChatTextArea", () => {
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

	test("surfaces skill discovery failures", async () => {
		const failure = new Error("Skill directory is unavailable");
		await expect(
			resolveSkillPrompt("/review", async () => {
				throw failure;
			})
		).rejects.toBe(failure);
	});

	test("keeps original skill command as visible history text", async () => {
		const textAreaSource = await readFile(
			new URL("./chat-text-area.tsx", import.meta.url),
			"utf8"
		);

		expect(textAreaSource).toContain("const visibleText = rawText.trim();");
		expect(textAreaSource).toContain("text: visibleText");
		expect(textAreaSource).toMatch(RESOLVE_SKILL_PROMPT_CALL);
	});

	test("replaces the full prompt when a skill command is selected", async () => {
		const textAreaSource = await readFile(
			new URL("./chat-text-area.tsx", import.meta.url),
			"utf8"
		);

		expect(textAreaSource).toContain("textarea.setText(command);");
		expect(textAreaSource).toContain("textarea.cursorOffset = command.length;");
		expect(textAreaSource).not.toContain("textarea.insertText(command);");
	});

	test("inserts custom command invocations and expands them on submit", async () => {
		const [textAreaSource, controllerSource] = await Promise.all([
			readFile(new URL("./chat-text-area.tsx", import.meta.url), "utf8"),
			readFile(
				new URL(
					"../../hooks/input-controller/use-chat-input-controller.ts",
					import.meta.url
				),
				"utf8"
			),
		]);

		expect(textAreaSource).toContain("resolveCustomCommandPrompt(");
		expect(textAreaSource).toContain(
			"expandCustomCommandTemplate(command.template"
		);
		expect(controllerSource).toContain("invocation =");
		expect(controllerSource).toContain("command.name");
		expect(controllerSource).toContain("setProgrammaticText(invocation");
		expect(controllerSource).not.toContain(
			'command.kind === "custom" && executeCommand'
		);
	});

	test("binds enter to submit and modified enter to newline", () => {
		expect(CHAT_TEXT_AREA_KEY_BINDINGS).toEqual([
			{ action: "submit", name: "return" },
			{ action: "submit", name: "enter" },
			{ action: "newline", name: "return", shift: true },
			{ action: "newline", name: "enter", shift: true },
			{ action: "newline", ctrl: true, name: "return" },
			{ action: "newline", ctrl: true, name: "enter" },
		]);
	});

	test("binds mouse wheel scrolling to command list navigation", async () => {
		const [textAreaSource, menuSource] = await Promise.all([
			readFile(new URL("./chat-text-area.tsx", import.meta.url), "utf8"),
			readFile(
				new URL("../../../commands/ui/command-menu.tsx", import.meta.url),
				"utf8"
			),
		]);

		expect(textAreaSource).toContain("onScroll={actions.onItemScroll}");
		expect(menuSource).toContain("onMouseScroll");
		expect(menuSource).toContain('event.scroll?.direction === "down"');
	});

	test("does not bind shift tab to model cycling", async () => {
		const [textAreaSource, promptConfigSource] = await Promise.all([
			readFile(new URL("./chat-text-area.tsx", import.meta.url), "utf8"),
			readFile(
				new URL(
					"../../../prompt-settings/context/prompt-config-provider.tsx",
					import.meta.url
				),
				"utf8"
			),
		]);

		expect(textAreaSource).not.toContain("cycleModel");
		expect(promptConfigSource).not.toContain("cycleModel");
	});

	test("syncs textarea text only for programmatic edits", async () => {
		const textAreaSource = await readFile(
			new URL("./chat-text-area.tsx", import.meta.url),
			"utf8"
		);

		expect(textAreaSource).toContain("lastTextSyncRevisionRef");
		expect(textAreaSource).toContain("state.textSyncRevision");
		expect(textAreaSource).not.toContain("textarea.plainText !== state.text");
	});

	test("highlights pasted image parts with the primary background", async () => {
		const textAreaSource = await readFile(
			new URL("./chat-text-area.tsx", import.meta.url),
			"utf8"
		);

		expect(textAreaSource).toContain("bg: colors.primary");
		expect(textAreaSource).toContain("fg: colors.background");
	});

	test("stages image-only prompts and keeps rejected prompts intact", async () => {
		const textAreaSource = await readFile(
			new URL("./chat-text-area.tsx", import.meta.url),
			"utf8"
		);

		expect(textAreaSource).toContain("submission: ChatPromptSubmission");
		expect(textAreaSource).toContain("MAX_IMAGE_ATTACHMENTS = 5");
		expect(textAreaSource).toContain("MAX_IMAGE_BYTES = 10 * 1024 * 1024");
		expect(textAreaSource).toContain("if (!text && files.length === 0)");
		expect(textAreaSource).toContain("if (accepted === false)");
		expect(textAreaSource).toContain(
			"getNextImageLabel(currentAttachments.length)"
		);
		expect(textAreaSource).toContain("textarea.extmarks.create");
	});

	test("stages native binary images and macOS path-like paste events", async () => {
		const textAreaSource = await readFile(
			new URL("./chat-text-area.tsx", import.meta.url),
			"utf8"
		);

		expect(textAreaSource).toContain("useKeyboard, usePaste");
		expect(textAreaSource).toContain('event.metadata?.kind === "binary"');
		expect(textAreaSource).toContain('mediaType?.startsWith("image/")');
		expect(textAreaSource).toContain("stageImage(event.bytes, mediaType)");
		expect(textAreaSource).toContain(
			"const pastedText = decodePasteBytes(event.bytes);"
		);
		expect(textAreaSource).toContain("? await readPastedImage()");
		expect(textAreaSource).toContain("basename(pastedText)");
		expect(textAreaSource).not.toContain('key.ctrl && key.name === "v"');
	});

	test("restores ordinary text paste after image lookup is unavailable", async () => {
		const textAreaSource = await readFile(
			new URL("./chat-text-area.tsx", import.meta.url),
			"utf8"
		);

		expect(textAreaSource).toContain("event.preventDefault();");
		expect(textAreaSource).toContain("textarea.handlePaste(event)");
		expect(textAreaSource).toContain("handleTextareaContentChange();");
		expect(textAreaSource).toContain("applyTextPaste(event);");
		expect(textAreaSource).toContain("pasteSequenceRef");
	});

	test("keeps only attachments whose extmarks still cover their tokens", () => {
		const token = getImageToken(4);
		const text = `Before ${token}after`;
		const start = text.indexOf(token);

		expect(getImageToken(4)).toBe("[Image 4]");
		expect(
			isAttachmentTokenExtant(text, token, {
				end: start + token.length,
				start,
			})
		).toBe(true);
		expect(
			isAttachmentTokenExtant("Before after", token, {
				end: start + token.length,
				start,
			})
		).toBe(false);
	});

	test("numbers pasted images from the current attachment count", () => {
		expect(getNextImageLabel(0)).toBe(1);
		expect(getNextImageLabel(1)).toBe(2);
		expect(getNextImageLabel(3)).toBe(4);
	});

	test("keeps trailing spaces outside persisted image token ranges", () => {
		expect(findImageTokenRanges("[Image 1] explain [Image 3]")).toEqual([
			{ label: 1, start: 0, token: "[Image 1]" },
			{ label: 3, start: 18, token: "[Image 3]" },
		]);
	});

	test("relocates attachments after programmatic file mention edits", () => {
		const attachment = {
			extmarkId: 1,
			file: {
				filename: "clipboard",
				mediaType: "image/png",
				type: "file" as const,
				url: "data:image/png;base64,aGVsbG8=",
			},
			id: "image-1",
			token: "[Image 1]",
		};

		expect(
			locateAttachmentTokens("Prompt [Image 1] @src/app.tsx", [attachment])
		).toEqual([{ attachment, start: 7 }]);

		const promptWithLiteralToken =
			"[Image 1] literal Prompt [Image 1] @src/app.tsx";
		expect(
			locateAttachmentTokens(promptWithLiteralToken, [attachment], [25])
		).toEqual([
			{ attachment, start: promptWithLiteralToken.lastIndexOf("[Image 1]") },
		]);
	});

	test("maps attachment offsets through one programmatic text replacement", () => {
		expect(
			mapOffsetThroughTextReplacement(
				"before @sr [Image 1] after",
				"before @src/app.ts [Image 1] after",
				11
			)
		).toBe(19);
		expect(
			mapOffsetThroughTextReplacement(
				"[Image 1] before @src/app.ts ",
				"[Image 1] before ",
				0
			)
		).toBe(0);
	});

	test("normalizes recalled image tokens to trimmed submission text", () => {
		expect(
			normalizeFileTokensForTrimmedText("  [Image 1] ", [
				{ start: 2, token: "[Image 1] " },
			])
		).toEqual([{ start: 0, token: "[Image 1]" }]);
	});

	test("keeps stable file mention extmarks while typing outside mentions", () => {
		expect(
			areFileMentionExtmarksCurrent(
				[{ end: 11, start: 0 }],
				[{ end: 11, start: 0, styleId: 4 }],
				4
			)
		).toBe(true);
		expect(
			areFileMentionExtmarksCurrent(
				[{ end: 12, start: 1 }],
				[{ end: 11, start: 0, styleId: 4 }],
				4
			)
		).toBe(false);
	});

	test("records live image parts on Ctrl+C without rebuilding highlights per key", async () => {
		const [textAreaSource, controllerSource] = await Promise.all([
			readFile(new URL("./chat-text-area.tsx", import.meta.url), "utf8"),
			readFile(
				new URL(
					"../../hooks/input-controller/use-chat-input-controller.ts",
					import.meta.url
				),
				"utf8"
			),
		]);

		expect(textAreaSource).toContain("return actions.onCtrlC(");
		expect(controllerSource).toContain(
			"rememberPrompt({ fileTokens, files, pastedText, text: textValue })"
		);
		expect(textAreaSource).not.toContain("textarea.clearAllHighlights()");
	});
});
