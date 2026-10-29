import { describe, expect, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { fromPartial } from "@total-typescript/shoehorn";
import { act, useMemo } from "react";
import type {
	CommandController,
	CommandSuggestion,
} from "@/modules/commands/command-controller";
import type { TrackedSubmissionIntent } from "@/modules/commands/submission-resolution";
import type { FileMentionOption } from "@/modules/file-mentions";
import type {
	PromptHistoryEntry,
	PromptHistoryStore,
} from "@/modules/sessions/hooks/input-controller/history";
import type { SubmitSnapshot } from "@/modules/sessions/hooks/input-controller/submit";
import type { ChatInputController } from "@/modules/sessions/hooks/input-controller/types";
import { useChatInputController } from "@/modules/sessions/hooks/input-controller/use-chat-input-controller";
import type { SessionMessage } from "@/modules/sessions/message";
import type { PromptHistoryEntry as StoredPromptHistoryEntry } from "@/modules/sessions/storage/session-store";
import type { SessionSubmissionComposition } from "@/modules/sessions/submission-types";
import { createComposerDocument } from "@/modules/sessions/ui/composer-document";
import type {
	ChatPromptComposition,
	ChatPromptSubmission,
} from "@/modules/sessions/utils";
import { testRenderWithClipboard } from "../support/clipboard";

const suggestion = fromPartial<CommandSuggestion>({
	description: "Review the project",
	id: "skill:review",
	label: "review",
});

const createCommandController = (
	seenIntents: CommandControllerInput["intents"][]
): CommandController => ({
	getSuggestions: () => ({ allItems: [suggestion], items: [suggestion] }),
	prepareSubmission: async (input) => {
		seenIntents.push(input.intents);
		return {
			accept: async (submit) => {
				const accepted = await submit({ text: input.text });
				return accepted !== false;
			},
			execute: async () => undefined,
		};
	},
	select: () => ({
		intent: { kind: "skill", name: "review" },
		invocation: "/skill:review",
		kind: "insert",
		reopen: false,
	}),
});

type CommandControllerInput = Parameters<
	CommandController["prepareSubmission"]
>[0];

type ControllerProbeProps = {
	commandController: CommandController;
	holder: { current: ChatInputController | null };
	onSubmit: (submission: ChatPromptSubmission) => boolean;
	sessionPromptHistory?: PromptHistoryEntry[];
	promptHistoryStore: PromptHistoryStore;
};

function ControllerProbe({
	commandController,
	holder,
	onSubmit,
	sessionPromptHistory = EMPTY_HISTORY,
	promptHistoryStore,
}: ControllerProbeProps) {
	const composerDocument = useMemo(createComposerDocument, []);
	const controller = useChatInputController({
		commandController,
		composerDocument,
		disabled: false,
		getFileMentionOptions: noFileMentions,
		onSubmit,
		onTab: () => undefined,
		sessionPromptHistory,
		promptHistoryStore,
	});
	holder.current = controller;
	return null;
}

const EMPTY_HISTORY: PromptHistoryEntry[] = [];
const noFileMentions = (): Promise<FileMentionOption[]> =>
	Promise.withResolvers<FileMentionOption[]>().promise;
const emptySnapshot = (rawText: string): SubmitSnapshot => ({
	fileTokens: [],
	files: [],
	pastedTexts: [],
	rawText,
});
const selectedSkillComposition = (text: string): ChatPromptComposition => {
	const marker = "/skill:review";
	const start = text.indexOf(marker);
	return {
		commandSelections: [
			{
				end: start + marker.length,
				kind: "skill",
				marker,
				name: "review",
				start,
			},
		],
		files: [],
		text,
	};
};

const createPromptHistoryStore = (
	recorded: StoredPromptHistoryEntry[]
): PromptHistoryStore =>
	fromPartial<PromptHistoryStore>({
		externalizeAttachments: async (messages: readonly SessionMessage[]) => [
			...messages,
		],
		getPromptHistory: async (): Promise<StoredPromptHistoryEntry[]> => [],
		recordPrompt: async (entry: StoredPromptHistoryEntry) => {
			recorded.push(entry);
		},
	});

const renderController = async (setup: TestRendererSetup): Promise<void> => {
	await act(async () => setup.renderOnce());
};

const waitForControllerEffects = async (
	setup: TestRendererSetup
): Promise<void> => {
	await Bun.sleep(10);
	await renderController(setup);
};

describe("composer command intent history and Recall", () => {
	test("history navigation restores the selected Skill intent without persisting it", async () => {
		const seenIntents: CommandControllerInput["intents"][] = [];
		const submissions: ChatPromptSubmission[] = [];
		const recordedPrompts: StoredPromptHistoryEntry[] = [];
		const promptHistoryStore = createPromptHistoryStore(recordedPrompts);
		const holder: { current: ChatInputController | null } = { current: null };
		const onSubmit = (submission: ChatPromptSubmission): boolean => {
			submissions.push(submission);
			return true;
		};
		const setup = await testRenderWithClipboard(
			<ControllerProbe
				commandController={createCommandController(seenIntents)}
				holder={holder}
				onSubmit={onSubmit}
				promptHistoryStore={promptHistoryStore}
			/>,
			{ height: 12, width: 80 }
		);

		try {
			await waitForControllerEffects(setup);
			await act(async () => {
				holder.current?.actions.onTextChange(
					{ files: [], text: "/rev" },
					4,
					""
				);
			});
			await renderController(setup);
			await act(async () => holder.current?.actions.onItemExecute(0));
			await renderController(setup);

			const text = "/skill:review explain";
			await act(async () => {
				holder.current?.actions.onTextChange(
					{ files: [], text },
					text.length,
					"/skill:review "
				);
			});
			await renderController(setup);
			await act(async () => {
				expect(await holder.current?.actions.submit(emptySnapshot(text))).toBe(
					true
				);
			});
			await waitForControllerEffects(setup);

			await act(async () => {
				expect(holder.current?.actions.onArrowUp(0, 0)).toBe(true);
			});
			await renderController(setup);
			expect(holder.current?.state.text).toBe(text);
			await act(async () => {
				expect(await holder.current?.actions.submit(emptySnapshot(text))).toBe(
					true
				);
			});

			expect(seenIntents).toEqual([
				[
					{
						end: "/skill:review".length,
						kind: "skill",
						marker: "/skill:review",
						name: "review",
						start: 0,
					},
				],
				[
					{
						end: "/skill:review".length,
						kind: "skill",
						marker: "/skill:review",
						name: "review",
						start: 0,
					},
				],
			]);
			expect(submissions[1]?.composition.commandSelections).toEqual(
				selectedSkillComposition(text).commandSelections
			);
			await waitForControllerEffects(setup);
			expect(recordedPrompts[0]).not.toHaveProperty("commandSelections");
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});

	test("queue Recall preserves draft intent and shifts recalled Skill ranges", async () => {
		const seenIntents: CommandControllerInput["intents"][] = [];
		const submissions: ChatPromptSubmission[] = [];
		const promptHistoryStore = createPromptHistoryStore([]);
		const holder: { current: ChatInputController | null } = { current: null };
		const setup = await testRenderWithClipboard(
			<ControllerProbe
				commandController={createCommandController(seenIntents)}
				holder={holder}
				onSubmit={(submission) => {
					submissions.push(submission);
					return true;
				}}
				promptHistoryStore={promptHistoryStore}
			/>,
			{ height: 12, width: 80 }
		);
		const firstEntry: SessionSubmissionComposition = {
			files: [],
			text: "summarize this",
		};
		const selectedText = "/skill:review then explain";
		const secondEntry = selectedSkillComposition(selectedText);
		const draftText = "/skill:review explain";
		const combinedText = `${draftText}\n\n${firstEntry.text}\n\n${selectedText}`;
		const draftStart = combinedText.indexOf("/skill:review");
		const recalledStart = combinedText.lastIndexOf("/skill:review");

		try {
			await waitForControllerEffects(setup);
			await act(async () => {
				holder.current?.actions.onTextChange(
					{ files: [], text: "/rev" },
					4,
					""
				);
			});
			await renderController(setup);
			await act(async () => holder.current?.actions.onItemExecute(0));
			await renderController(setup);
			await act(async () => {
				holder.current?.actions.onTextChange(
					{ files: [], text: draftText },
					draftText.length,
					"/skill:review "
				);
			});
			await renderController(setup);
			await act(async () => {
				holder.current?.actions.recall([firstEntry, secondEntry], {
					files: [],
					text: draftText,
				});
			});
			await renderController(setup);
			await act(async () => {
				expect(
					await holder.current?.actions.submit(emptySnapshot(combinedText))
				).toBe(true);
			});

			const expectedSelections: TrackedSubmissionIntent[] = [
				{
					end: draftStart + "/skill:review".length,
					kind: "skill",
					marker: "/skill:review",
					name: "review",
					start: draftStart,
				},
				{
					end: recalledStart + "/skill:review".length,
					kind: "skill",
					marker: "/skill:review",
					name: "review",
					start: recalledStart,
				},
			];
			expect(seenIntents).toEqual([expectedSelections]);
			expect(submissions[0]?.composition.commandSelections).toEqual(
				expectedSelections
			);
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});
});
