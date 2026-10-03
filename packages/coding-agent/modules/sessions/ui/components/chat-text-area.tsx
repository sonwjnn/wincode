import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	decodePasteBytes,
	type PasteEvent,
	SyntaxStyle,
	type TextareaRenderable,
} from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import {
	findSupportedChatModelSelection,
	getSupportedModelEfforts,
	getSupportedReasoningModes,
	supportedChatModelIdSchema,
} from "@wincode/ai/models";
import { isNull, isUndefined, omitUndefined } from "@wincode/runtime-utils";
import { spawn } from "bun";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CommandSuggestion } from "@/modules/commands/command-controller";
import { useCommandControllerFactory } from "@/modules/commands/command-controller-context";
import type { CommandCapability } from "@/modules/commands/commands";
import {
	deleteFileMentionAfterTrailingCharacterDelete,
	type FileMentionOption,
	findFileMentionRanges,
	getFileMentionOptions,
} from "@/modules/file-mentions";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { StatusBar } from "@/modules/prompt-settings/ui/prompt-status-bar";
import { useLatest } from "@/shared/hooks/use-latest";
import { CHAT_TEXT_AREA_KEY_BINDINGS } from "@/shared/providers/keyboard-layer/constants";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { getAgentColor } from "@/shared/providers/theme/themes";
import { useToast } from "@/shared/providers/toast/toast-provider";
import { BorderedContentBlock } from "@/shared/ui/bordered-content-block";
import { SelectableList } from "@/shared/ui/selectable-list";
import {
	areFileMentionExtmarksCurrent,
	type ChatAttachment,
	findImageTokenRanges,
	getImageToken,
	getNextImageLabel,
	isAttachmentTokenExtant,
	locateAttachmentTokens,
	mapOffsetThroughTextReplacement,
	normalizeFileTokensForTrimmedText,
} from "../../attachments";
import { readClipboardImage, readImagePath } from "../../clipboard-image";
import type { PromptHistoryEntry } from "../../hooks/input-controller/history";
import type { TrackedPastedText } from "../../hooks/input-controller/submit";
import { useChatInputController } from "../../hooks/input-controller/use-chat-input-controller";
import { summarizePastedText } from "../../pasted-text";
import type { SessionSubmissionComposition } from "../../submission-types";
import type { ChatPromptSubmission } from "../../utils";

const MAX_IMAGE_ATTACHMENTS = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const EMPTY_PROMPT_HISTORY: PromptHistoryEntry[] = [];
const EMPTY_RECALLED_SUBMISSIONS: readonly SessionSubmissionComposition[] = [];
const EMPTY_COMMAND_CAPABILITIES: readonly CommandCapability[] = [];
const toSelectableCommandItem = (item: CommandSuggestion) => ({
	description: item.description,
	id: item.id,
	label: item.label,
});

const toSelectableFileMentionItem = (item: FileMentionOption) => ({
	id: item.path,
	label: item.label,
});

const getAttachmentFileTokens = (
	textarea: TextareaRenderable,
	attachments: ChatAttachment[]
): Array<{ start: number; token: string }> =>
	attachments.flatMap((attachment) => {
		const extmark = textarea.extmarks.get(attachment.extmarkId);
		return extmark ? [{ start: extmark.start, token: attachment.token }] : [];
	});

const getTrackedPastedTexts = (
	textarea: TextareaRenderable,
	pastedTexts: Array<{ extmarkId: number; text: string; token: string }>
): TrackedPastedText[] =>
	pastedTexts.flatMap(({ extmarkId, text, token }) => {
		const extmark = textarea.extmarks.get(extmarkId);
		return extmark &&
			isAttachmentTokenExtant(textarea.plainText, token, extmark)
			? [{ end: extmark.end, start: extmark.start, text, token }]
			: [];
	});

type ChatTextAreaProps = {
	id: string;
	disabled?: boolean;
	draftKey?: string;
	unavailableCommandCapabilities?: readonly CommandCapability[];
	onCompact?: (focus?: string) => Promise<boolean> | boolean;
	onOpenSettings?: (section?: string) => Promise<void> | void;
	onEmptySubmit?: () => void | Promise<void>;
	/** Compositions a Recall returned, oldest first, waiting to enter the composer. */
	recalledSubmissions?: readonly SessionSubmissionComposition[];
	/** Changes whenever `recalledSubmissions` holds something new to restore. */
	recallRevision?: number;
	sessionPromptHistory?: PromptHistoryEntry[];
	onSubmit: (
		submission: ChatPromptSubmission
	) => boolean | Promise<boolean> | void | Promise<void>;
};

const readPastedImage = () =>
	readClipboardImage({
		environment: process.env,
		readFile: (path) => Bun.file(path).bytes(),
		stat: async (path) => stat(path),
		removeFile: (path) => rm(path, { force: true }),
		run: async (command, args) => {
			const childProcess = spawn([command, ...args], {
				stderr: "ignore",
				stdout: "pipe",
			});
			return {
				exitCode: await childProcess.exited,
				stdout: new Uint8Array(
					await new Response(childProcess.stdout).arrayBuffer()
				),
			};
		},
		temporaryPath: () =>
			join(tmpdir(), `wincode-clipboard-${crypto.randomUUID()}.png`),
	});

const readPastedImageOrPath = async (pastedText: string) => {
	const pathImage = pastedText
		? await readImagePath(pastedText, {
				readFile: (path) => Bun.file(path).bytes(),
				stat: async (path) => stat(path),
			})
		: { unavailable: true as const };
	return {
		image:
			!pastedText || "unavailable" in pathImage
				? await readPastedImage()
				: pathImage,
		pathImage,
	};
};
export function ChatTextArea({
	id,
	disabled = false,
	draftKey,
	unavailableCommandCapabilities:
		viewUnavailableCapabilities = EMPTY_COMMAND_CAPABILITIES,
	onCompact,
	onOpenSettings,
	onSubmit,
	onEmptySubmit,
	recalledSubmissions = EMPTY_RECALLED_SUBMISSIONS,
	recallRevision = 0,
	sessionPromptHistory = EMPTY_PROMPT_HISTORY,
}: ChatTextAreaProps) {
	const { agent, cycleReasoningChoice, model } = usePromptConfig();
	const supportedModel = findSupportedChatModelSelection(model);
	const chatModelSelection = isNull(supportedModel)
		? null
		: {
				modelId: supportedChatModelIdSchema.parse(supportedModel.id),
				providerId: supportedModel.connectionProviderId,
			};
	const hideEffort =
		chatModelSelection === null ||
		(getSupportedModelEfforts(chatModelSelection).length === 0 &&
			getSupportedReasoningModes(chatModelSelection).length === 0);
	const unavailableCommandCapabilities = useMemo(() => {
		const unavailable = new Set<CommandCapability>(viewUnavailableCapabilities);
		if (!onCompact) {
			unavailable.add("compaction");
		}
		if (hideEffort) {
			unavailable.add("effort-selection");
		}
		return [...unavailable];
	}, [hideEffort, onCompact, viewUnavailableCapabilities]);
	const textAreaRef = useRef<TextareaRenderable>(null);
	const ctrlCRef = useRef<() => boolean>(() => false);
	const lastRecalledFilesRevisionRef = useRef(0);
	const lastRecallRevisionRef = useRef(recallRevision);
	const lastTextSyncRevisionRef = useRef(0);
	const programmaticTextRef = useRef<string | null>(null);
	const onSubmitRef = useRef<() => Promise<void>>(async () => undefined);
	const onEmptySubmitRef = useLatest(onEmptySubmit);
	const pasteSequenceRef = useRef(0);
	const attachmentsRef = useRef<ChatAttachment[]>([]);
	const fileMentionExtmarkIdsRef = useRef<number[]>([]);
	const restoreAttachmentsAfterSetTextRef = useRef<
		(
			textarea: TextareaRenderable,
			text: string,
			attachments: ChatAttachment[],
			expectedStarts: number[]
		) => ChatAttachment[]
	>(() => []);
	const syncAttachmentsRef = useRef<() => ChatAttachment[]>(() => []);
	const syncFileMentionExtmarksRef = useRef<() => void>(() => undefined);

	const { isTopLayer, pop, push, setResponder } = useKeyboardLayer();
	const { colors } = useTheme();
	const { show } = useToast();
	const commandControllerFactory = useCommandControllerFactory();
	const mentionSyntaxStyle = useMemo(
		() =>
			SyntaxStyle.fromStyles({
				attachment: {
					bg: colors.primary,
					bold: true,
					fg: colors.background,
				},
				fileMention: { bold: true, fg: colors.primary },
				pastedText: {
					bg: colors.primary,
					bold: true,
					fg: colors.background,
				},
			}),
		[colors.background, colors.primary]
	);
	const pastedTextStyleId = mentionSyntaxStyle.getStyleId("pastedText");
	const pastedTextRef = useRef<
		Array<{ extmarkId: number; text: string; token: string }>
	>([]);
	const syncPastedTexts = useCallback(() => {
		const textarea = textAreaRef.current;
		if (!textarea) {
			return [];
		}

		pastedTextRef.current = pastedTextRef.current
			.filter(({ extmarkId, token }) => {
				const extmark = textarea.extmarks.get(extmarkId);
				return (
					!isNull(extmark) &&
					isAttachmentTokenExtant(textarea.plainText, token, extmark)
				);
			})
			.sort(
				(left, right) =>
					(textarea.extmarks.get(left.extmarkId)?.start ?? 0) -
					(textarea.extmarks.get(right.extmarkId)?.start ?? 0)
			);
		return pastedTextRef.current;
	}, []);

	const handleSubmitError = useCallback(
		(message: string) => {
			show({ message, variant: "error" });
		},
		[show]
	);
	const commandController = useMemo(
		() =>
			commandControllerFactory.create({
				unavailableCapabilities: unavailableCommandCapabilities,
				onCompact,
				onError: handleSubmitError,
				onOpenSettings,
			}),
		[
			commandControllerFactory,
			handleSubmitError,
			onCompact,
			onOpenSettings,
			unavailableCommandCapabilities,
		]
	);
	const { actions, state } = useChatInputController({
		disabled,
		commandController,
		draftKey,
		getFileMentionOptions,
		onSubmit,
		onTab: (shift) => {
			if (shift) {
				cycleReasoningChoice();
			}
		},
		sessionPromptHistory,
	});
	const commandEscapeRef = useLatest(actions.onEscape);
	const currentTextRef = useLatest(state.text);

	const handleTextareaContentChange = useCallback(() => {
		const textarea = textAreaRef.current;
		if (!textarea) {
			return;
		}

		const mentionDelete = isNull(state.overlay.kind)
			? deleteFileMentionAfterTrailingCharacterDelete(
					currentTextRef.current,
					textarea.plainText,
					textarea.cursorOffset
				)
			: null;
		if (mentionDelete) {
			const previousAttachments = attachmentsRef.current;
			const previousText = textarea.plainText;
			const previousStarts = getAttachmentFileTokens(
				textarea,
				previousAttachments
			).map(({ start }) =>
				mapOffsetThroughTextReplacement(previousText, mentionDelete.text, start)
			);
			textarea.setText(mentionDelete.text);
			attachmentsRef.current = restoreAttachmentsAfterSetTextRef.current(
				textarea,
				mentionDelete.text,
				previousAttachments,
				previousStarts
			);
			textarea.cursorOffset = mentionDelete.cursorOffset;
			actions.onTextChange(
				mentionDelete.text,
				mentionDelete.cursorOffset,
				attachmentsRef.current.map((attachment) => attachment.file),
				getAttachmentFileTokens(textarea, attachmentsRef.current)
			);
			syncFileMentionExtmarksRef.current();
			return;
		}

		if (programmaticTextRef.current === textarea.plainText) {
			programmaticTextRef.current = null;
			actions.onProgrammaticTextChange(
				textarea.plainText,
				textarea.cursorOffset
			);
			return;
		}
		const attachments = syncAttachmentsRef.current();
		syncPastedTexts();
		actions.onTextChange(
			textarea.plainText,
			textarea.cursorOffset,
			attachments.map((attachment) => attachment.file),
			getAttachmentFileTokens(textarea, attachments)
		);
		syncFileMentionExtmarksRef.current();
	}, [actions, state.overlay.kind, syncPastedTexts]);

	const syncAttachments = useCallback(() => {
		const textarea = textAreaRef.current;
		if (!textarea) {
			return [];
		}

		attachmentsRef.current = attachmentsRef.current
			.filter((attachment) => {
				const extmark = textarea.extmarks.get(attachment.extmarkId);
				return (
					!isNull(extmark) &&
					isAttachmentTokenExtant(textarea.plainText, attachment.token, extmark)
				);
			})
			.sort((left, right) => {
				const leftStart = textarea.extmarks.get(left.extmarkId)?.start ?? 0;
				const rightStart = textarea.extmarks.get(right.extmarkId)?.start ?? 0;
				return leftStart - rightStart;
			});
		return attachmentsRef.current;
	}, []);
	syncAttachmentsRef.current = syncAttachments;

	const createAttachmentExtmark = useCallback(
		(
			textarea: TextareaRenderable,
			id: string,
			token: string,
			start: number
		) => {
			const styleId = mentionSyntaxStyle.getStyleId("attachment");
			return textarea.extmarks.create({
				data: id,
				end: start + token.length,
				metadata: { attachmentId: id },
				priority: 20,
				start,
				typeId: 1,
				virtual: true,
				...omitUndefined({ styleId: styleId ?? undefined }),
			});
		},
		[mentionSyntaxStyle]
	);

	const restoreAttachmentsAfterSetText = useCallback(
		(
			textarea: TextareaRenderable,
			text: string,
			attachments: ChatAttachment[],
			expectedStarts: number[]
		): ChatAttachment[] =>
			locateAttachmentTokens(text, attachments, expectedStarts).map(
				({ attachment, start }) => ({
					...attachment,
					extmarkId: createAttachmentExtmark(
						textarea,
						attachment.id,
						attachment.token,
						start
					),
				})
			),
		[createAttachmentExtmark]
	);
	restoreAttachmentsAfterSetTextRef.current = restoreAttachmentsAfterSetText;

	const syncFileMentionExtmarks = useCallback(() => {
		const textarea = textAreaRef.current;
		const styleId = mentionSyntaxStyle.getStyleId("fileMention");
		if (!(textarea && !isNull(styleId))) {
			return;
		}

		const ranges = findFileMentionRanges(textarea.plainText);
		const extmarks = fileMentionExtmarkIdsRef.current.map((id) =>
			textarea.extmarks.get(id)
		);
		if (areFileMentionExtmarksCurrent(ranges, extmarks, styleId)) {
			return;
		}

		for (const id of fileMentionExtmarkIdsRef.current) {
			textarea.extmarks.delete(id);
		}
		fileMentionExtmarkIdsRef.current = ranges.map((range) =>
			textarea.extmarks.create({
				end: range.end,
				priority: 10,
				start: range.start,
				styleId,
				typeId: 2,
			})
		);
	}, [mentionSyntaxStyle]);
	syncFileMentionExtmarksRef.current = syncFileMentionExtmarks;

	useEffect(() => {
		if (lastTextSyncRevisionRef.current === state.textSyncRevision) {
			return;
		}

		lastTextSyncRevisionRef.current = state.textSyncRevision;

		const textarea = textAreaRef.current;
		if (!textarea) {
			return;
		}

		programmaticTextRef.current = state.text;
		const previousAttachments = attachmentsRef.current;
		const previousPastedTexts = syncPastedTexts();
		const previousText = textarea.plainText;
		const previousStarts = getAttachmentFileTokens(
			textarea,
			previousAttachments
		).map(({ start }) =>
			mapOffsetThroughTextReplacement(previousText, state.text, start)
		);
		const previousPastedStarts = getTrackedPastedTexts(
			textarea,
			previousPastedTexts
		).map(({ start }) =>
			mapOffsetThroughTextReplacement(previousText, state.text, start)
		);
		textarea.setText(state.text);
		attachmentsRef.current = restoreAttachmentsAfterSetText(
			textarea,
			state.text,
			previousAttachments,
			previousStarts
		);
		const claimedPastedStarts = new Set<number>();
		pastedTextRef.current = previousPastedTexts.flatMap((pasted, index) => {
			const candidates: number[] = [];
			let start = state.text.indexOf(pasted.token);
			while (start !== -1) {
				if (!claimedPastedStarts.has(start)) {
					candidates.push(start);
				}
				start = state.text.indexOf(pasted.token, start + pasted.token.length);
			}
			const expectedStart = previousPastedStarts[index];
			const matchedStart = candidates.toSorted(
				(left, right) =>
					Math.abs(left - (expectedStart ?? left)) -
					Math.abs(right - (expectedStart ?? right))
			)[0];
			if (isUndefined(matchedStart)) {
				return [];
			}
			claimedPastedStarts.add(matchedStart);
			return [
				{
					...pasted,
					extmarkId: textarea.extmarks.create({
						end: matchedStart + pasted.token.length,
						start: matchedStart,
						virtual: true,
						...omitUndefined({ styleId: pastedTextStyleId ?? undefined }),
					}),
				},
			];
		});
		for (const id of fileMentionExtmarkIdsRef.current) {
			textarea.extmarks.delete(id);
		}
		fileMentionExtmarkIdsRef.current = [];
		syncFileMentionExtmarks();

		if (!isNull(state.cursorOffset)) {
			textarea.cursorOffset = state.cursorOffset;
		}
	}, [
		restoreAttachmentsAfterSetText,
		pastedTextStyleId,
		state.cursorOffset,
		state.text,
		state.textSyncRevision,
		syncPastedTexts,
		syncFileMentionExtmarks,
	]);

	useEffect(() => {
		if (lastRecalledFilesRevisionRef.current === state.recalledFilesRevision) {
			return;
		}
		lastRecalledFilesRevisionRef.current = state.recalledFilesRevision;

		const textarea = textAreaRef.current;
		if (!textarea) {
			return;
		}

		for (const attachment of attachmentsRef.current) {
			textarea.extmarks.delete(attachment.extmarkId);
		}
		attachmentsRef.current = [];

		const normalizedRecalledTokenRanges = state.recalledFileTokens.map(
			({ start, token }) => ({ start, token: token.trimEnd() })
		);
		const recalledTokenRanges = normalizedRecalledTokenRanges.filter(
			({ start, token }) =>
				textarea.plainText.slice(start, start + token.length) === token
		);
		const parsedTokenRanges = findImageTokenRanges(textarea.plainText);
		const tokenRanges =
			state.recalledFileTokens.length === state.recalledFiles.length
				? recalledTokenRanges
				: parsedTokenRanges;
		if (tokenRanges.length !== state.recalledFiles.length) {
			return;
		}

		attachmentsRef.current = state.recalledFiles.map((file, index) => {
			const range = tokenRanges[index];
			if (!range) {
				throw new Error("Missing recalled image token");
			}

			const id = crypto.randomUUID();
			return {
				extmarkId: createAttachmentExtmark(
					textarea,
					id,
					range.token,
					range.start
				),
				file,
				id,
				token: range.token,
			};
		});
	}, [
		createAttachmentExtmark,
		state.recalledFiles,
		state.recalledFileTokens,
		state.recalledFilesRevision,
	]);

	useEffect(() => {
		const textarea = textAreaRef.current;
		if (!textarea || state.recalledPastedTextsRevision === 0) {
			return;
		}
		for (const record of pastedTextRef.current) {
			textarea.extmarks.delete(record.extmarkId);
		}
		pastedTextRef.current = [];
		let searchStart = 0;
		for (const pasted of state.recalledPastedTexts) {
			const start = textarea.plainText.indexOf(pasted.token, searchStart);
			if (start < 0) {
				continue;
			}
			searchStart = start + pasted.token.length;
			const extmarkId = textarea.extmarks.create({
				end: start + pasted.token.length,
				start,
				virtual: true,
				...omitUndefined({ styleId: pastedTextStyleId ?? undefined }),
			});
			pastedTextRef.current.push({ extmarkId, ...pasted });
		}
	}, [
		pastedTextStyleId,
		state.recalledPastedTexts,
		state.recalledPastedTextsRevision,
	]);

	useEffect(() => {
		const textarea = textAreaRef.current;
		if (!textarea || lastRecallRevisionRef.current === recallRevision) {
			return;
		}
		lastRecallRevisionRef.current = recallRevision;
		if (recalledSubmissions.length === 0) {
			return;
		}
		const attachments = syncAttachments();
		actions.recall(recalledSubmissions, {
			fileTokens: getAttachmentFileTokens(textarea, attachments),
			files: attachments.map((attachment) => attachment.file),
			pastedText: syncPastedTexts().map(({ text, token }) => ({
				text,
				token,
			})),
			text: textarea.plainText,
		});
	}, [
		actions.recall,
		recalledSubmissions,
		recallRevision,
		syncAttachments,
		syncPastedTexts,
	]);

	useEffect(() => {
		const textarea = textAreaRef.current;
		if (!textarea) {
			return;
		}

		textarea.syntaxStyle = mentionSyntaxStyle;

		attachmentsRef.current = syncAttachments().map((attachment) => {
			const extmark = textarea.extmarks.get(attachment.extmarkId);
			if (!extmark) {
				return attachment;
			}

			textarea.extmarks.delete(attachment.extmarkId);
			return {
				...attachment,
				extmarkId: createAttachmentExtmark(
					textarea,
					attachment.id,
					attachment.token,
					extmark.start
				),
			};
		});

		for (const id of fileMentionExtmarkIdsRef.current) {
			textarea.extmarks.delete(id);
		}
		fileMentionExtmarkIdsRef.current = [];
		syncFileMentionExtmarks();
	}, [
		createAttachmentExtmark,
		mentionSyntaxStyle,
		syncAttachments,
		syncFileMentionExtmarks,
	]);

	useEffect(() => {
		const textarea = textAreaRef.current;
		if (!textarea) {
			return;
		}

		textarea.onSubmit = async () => {
			await onSubmitRef.current();
		};
	}, []);

	onSubmitRef.current = async () => {
		const overlay = state.overlay;
		if (
			overlay.kind !== null &&
			(overlay.kind !== "command" || overlay.items.length > 0)
		) {
			actions.onEnter();
			return;
		}

		const textarea = textAreaRef.current;
		const rawText = textarea?.plainText ?? "";
		const pastedTexts = textarea
			? getTrackedPastedTexts(textarea, syncPastedTexts())
			: [];
		const attachments = syncAttachments();
		const submitEmpty = onEmptySubmitRef.current;
		if (
			submitEmpty &&
			rawText.trim().length === 0 &&
			attachments.length === 0 &&
			pastedTexts.length === 0
		) {
			await submitEmpty();
			return;
		}
		const accepted = await actions.submit({
			fileTokens: textarea
				? normalizeFileTokensForTrimmedText(
						rawText,
						getAttachmentFileTokens(textarea, attachments)
					)
				: [],
			files: attachments.map((attachment) => attachment.file),
			pastedTexts,
			rawText,
		});
		if (!accepted) {
			return;
		}

		for (const attachment of attachmentsRef.current) {
			textarea?.extmarks.delete(attachment.extmarkId);
		}
		for (const pastedText of pastedTextRef.current) {
			textarea?.extmarks.delete(pastedText.extmarkId);
		}
		attachmentsRef.current = [];
		textAreaRef.current?.setText("");
		pastedTextRef.current = [];
	};
	ctrlCRef.current = () => {
		const textarea = textAreaRef.current;
		const attachments = syncAttachments();
		const pastedTexts = textarea ? syncPastedTexts() : [];
		return actions.onCtrlC(
			attachments.map((attachment) => attachment.file),
			textarea ? getAttachmentFileTokens(textarea, attachments) : [],
			pastedTexts.map(({ text, token }) => ({ text, token }))
		);
	};

	useEffect(() => {
		if (isNull(state.overlay.kind)) {
			return;
		}

		push("command", () => {
			commandEscapeRef.current();
			return true;
		});

		return () => pop("command");
	}, [pop, push, state.overlay.kind]);

	useEffect(() => {
		setResponder("base", () => ctrlCRef.current());

		return () => setResponder("base", null);
	}, [setResponder]);

	const stageImage = useCallback(
		(bytes: Uint8Array, mediaType: string, filename = "clipboard") => {
			if (bytes.byteLength > MAX_IMAGE_BYTES) {
				show({
					message: "Images must be 10 MiB or smaller.",
					variant: "error",
				});
				return;
			}

			const textarea = textAreaRef.current;
			if (!textarea) {
				return;
			}
			const currentAttachments = syncAttachments();
			if (currentAttachments.length >= MAX_IMAGE_ATTACHMENTS) {
				show({
					message: `You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`,
					variant: "error",
				});
				return;
			}

			const id = crypto.randomUUID();
			const token = getImageToken(getNextImageLabel(currentAttachments.length));
			const start = textarea.cursorOffset;
			textarea.insertText(`${token} `);
			const extmarkId = createAttachmentExtmark(textarea, id, token, start);
			attachmentsRef.current.push({
				extmarkId,
				file: {
					filename,
					mediaType,
					type: "file",
					url: `data:${mediaType};base64,${bytes.toBase64()}`,
				},
				id,
				token,
			});
			handleTextareaContentChange();
		},
		[
			createAttachmentExtmark,
			handleTextareaContentChange,
			show,
			syncAttachments,
		]
	);

	const applyTextPaste = useCallback(
		(event: PasteEvent) => {
			const textarea = textAreaRef.current;
			if (!textarea) {
				return;
			}

			textarea.handlePaste(event);
			handleTextareaContentChange();
		},
		[handleTextareaContentChange]
	);

	const stagePastedText = useCallback(
		(pastedText: string): boolean => {
			const summary = summarizePastedText(pastedText);
			if (!summary) {
				return false;
			}

			const textarea = textAreaRef.current;
			if (!textarea) {
				return true;
			}

			const start = textarea.cursorOffset;
			textarea.insertText(`${summary.token} `);
			const extmarkId = textarea.extmarks.create({
				end: start + summary.token.length,
				start,
				...omitUndefined({ styleId: pastedTextStyleId ?? undefined }),
				virtual: true,
			});
			pastedTextRef.current.push({ extmarkId, ...summary });
			handleTextareaContentChange();
			return true;
		},
		[handleTextareaContentChange, pastedTextStyleId]
	);

	const handlePasteEvent = useCallback(
		async (event: PasteEvent) => {
			const mediaType = event.metadata?.mimeType;
			if (disabled || !(isTopLayer("base") || isTopLayer("command"))) {
				return;
			}
			const pasteSequence = pasteSequenceRef.current + 1;
			pasteSequenceRef.current = pasteSequence;
			if (
				event.metadata?.kind === "binary" &&
				mediaType?.startsWith("image/")
			) {
				event.preventDefault();
				stageImage(event.bytes, mediaType);
				return;
			}

			event.preventDefault();
			const pastedText = decodePasteBytes(event.bytes);
			const { image, pathImage } = await readPastedImageOrPath(pastedText);
			if (pasteSequence !== pasteSequenceRef.current) {
				applyTextPaste(event);
				return;
			}
			if ("unavailable" in image) {
				if (!stagePastedText(pastedText)) {
					applyTextPaste(event);
				}
				return;
			}

			stageImage(
				image.bytes,
				image.mediaType,
				"unavailable" in pathImage ? "clipboard" : basename(pastedText)
			);
		},
		[applyTextPaste, disabled, isTopLayer, stageImage, stagePastedText]
	);

	usePaste((event) => {
		handlePasteEvent(event).catch(() => applyTextPaste(event));
	});

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: keyboard priority branches are intentionally co-located.
	useKeyboard((key) => {
		if (disabled) {
			return;
		}

		if (!isNull(state.overlay.kind) && isTopLayer("command")) {
			if (key.name === "escape") {
				key.preventDefault();
				actions.onEscape();
				return;
			}

			if (key.name === "up") {
				key.preventDefault();
				actions.onArrowUp();
				return;
			}

			if (key.name === "down") {
				key.preventDefault();
				actions.onArrowDown();
				return;
			}
		}

		if (
			isTopLayer("base") &&
			key.ctrl === false &&
			key.shift === false &&
			key.meta === false &&
			key.option === false &&
			(key.name === "up" || key.name === "down")
		) {
			const textarea = textAreaRef.current;
			if (textarea) {
				const consumed = (
					key.name === "up" ? actions.onArrowUp : actions.onArrowDown
				)(textarea.cursorOffset, textarea.plainText.length);
				if (consumed) {
					key.preventDefault();
				}
			}
			return;
		}

		if (
			key.name === "tab" &&
			!isNull(state.overlay.kind) &&
			isTopLayer("command")
		) {
			key.preventDefault();
			actions.onTab(key.shift);
			return;
		}

		if (!isTopLayer("base")) {
			return;
		}

		if (key.name === "tab") {
			key.preventDefault();
			actions.onTab(key.shift);
		}
	});

	const isFocused = !disabled && (isTopLayer("base") || isTopLayer("command"));

	return (
		<box
			alignItems="center"
			overflow="visible"
			position="relative"
			width="100%"
		>
			{state.overlay.kind === "command" && (
				<box bottom="100%" left={0} position="absolute" right={0} zIndex={10}>
					<BorderedContentBlock
						border={["left", "right"]}
						borderColor={colors.borderActive}
						colors={colors}
						contentGap={0}
						customBorderChars={{ vertical: "┃" }}
						marginBottom={0}
						paddingX={0}
						paddingY={0}
					>
						<SelectableList
							emptyMessage="No matching commands"
							items={state.overlay.items.map(toSelectableCommandItem)}
							onConfirm={actions.onItemExecute}
							onSelect={actions.onItemSelect}
							selectedIndex={state.overlay.selectedIndex}
							widthBasis={state.overlay.allItems.map(toSelectableCommandItem)}
						/>
					</BorderedContentBlock>
				</box>
			)}

			{state.overlay.kind === "file-mention" && (
				<box bottom="100%" left={0} position="absolute" right={0} zIndex={10}>
					<BorderedContentBlock
						border={["left", "right"]}
						borderColor={colors.borderActive}
						colors={colors}
						contentGap={0}
						customBorderChars={{ vertical: "┃" }}
						marginBottom={0}
						paddingX={0}
						paddingY={0}
					>
						<SelectableList
							emptyMessage="No matching files"
							items={state.overlay.items.map(toSelectableFileMentionItem)}
							onConfirm={actions.onItemExecute}
							onSelect={actions.onItemSelect}
							selectedIndex={state.overlay.selectedIndex}
						/>
					</BorderedContentBlock>
				</box>
			)}

			<BorderedContentBlock
				borderColor={getAgentColor(colors, agent)}
				colors={colors}
				contentGap={1}
				contentJustifyContent="center"
				marginBottom={0}
				paddingX={2}
				paddingY={1}
			>
				<textarea
					focused={isFocused}
					focusedTextColor={disabled ? colors.textDisabled : colors.text}
					id={id}
					keyBindings={CHAT_TEXT_AREA_KEY_BINDINGS}
					onContentChange={handleTextareaContentChange}
					placeholder={`Ask anything... "Fix broken tests"`}
					placeholderColor={colors.textMuted}
					ref={textAreaRef}
					textColor={disabled ? colors.textDisabled : colors.text}
				/>
				<StatusBar />
			</BorderedContentBlock>
		</box>
	);
}
