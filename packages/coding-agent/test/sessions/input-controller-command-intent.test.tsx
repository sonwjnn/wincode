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
	PluginAutocompleteProviderFactory,
	PluginAutocompleteResult,
} from "@/modules/plugins/public";
import type { PromptHistoryEntry } from "@/modules/sessions/hooks/input-controller/history";
import type { SubmitSnapshot } from "@/modules/sessions/hooks/input-controller/submit";
import type {
	ChatInputController,
	InputOverlayState,
} from "@/modules/sessions/hooks/input-controller/types";
import { useChatInputController } from "@/modules/sessions/hooks/input-controller/use-chat-input-controller";
import type { SessionMessage } from "@/modules/sessions/message";
import type {
	PromptHistoryStore,
	PromptHistoryEntry as StoredPromptHistoryEntry,
} from "@/modules/sessions/storage/prompt-history";
import type { SessionSubmissionComposition } from "@/modules/sessions/submission-types";
import {
	type ComposerDocument,
	createComposerDocument,
} from "@/modules/sessions/ui/composer-document";
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
	seenIntents: CommandControllerInput["intents"][],
	getArgumentCompletions: CommandController["getArgumentCompletions"] = async () =>
		null,
	isPluginArgumentCompletionActive: CommandController["isPluginArgumentCompletionActive"] = () =>
		true
): CommandController => ({
	getSuggestions: () => ({ allItems: [suggestion], items: [suggestion] }),
	getArgumentCompletions,
	isPluginArgumentCompletionActive,
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
	documentHolder?: { current: ComposerDocument | null };
	getFileMentionOptions?: () => Promise<FileMentionOption[]>;
	holder: { current: ChatInputController | null };
	onSubmit: (submission: ChatPromptSubmission) => boolean;
	pluginAutocompleteProviders?: readonly PluginAutocompleteProviderFactory[];
	pluginAutocompleteProvidersHolder?: {
		current: readonly PluginAutocompleteProviderFactory[];
	};
	renderedOverlayKinds?: InputOverlayState["kind"][];
	sessionId?: string;
	sessionPromptHistory?: PromptHistoryEntry[];
	promptHistoryStore: PromptHistoryStore;
};

function ControllerProbe({
	commandController,
	documentHolder,
	getFileMentionOptions: getFileMentionOptionsFromProps = noFileMentions,
	holder,
	onSubmit,
	pluginAutocompleteProviders,
	pluginAutocompleteProvidersHolder,
	renderedOverlayKinds,
	sessionId,
	sessionPromptHistory = EMPTY_HISTORY,
	promptHistoryStore,
}: ControllerProbeProps) {
	const composerDocument = useMemo(createComposerDocument, []);
	if (documentHolder !== undefined) {
		documentHolder.current = composerDocument;
	}
	const activePluginAutocompleteProviders =
		pluginAutocompleteProvidersHolder?.current ?? pluginAutocompleteProviders;
	const controller = useChatInputController({
		commandController,
		composerDocument,
		disabled: false,
		getFileMentionOptions: getFileMentionOptionsFromProps,
		pluginAutocompleteProviders: activePluginAutocompleteProviders,
		sessionId,
		onSubmit,
		onTab: () => undefined,
		sessionPromptHistory,
		promptHistoryStore,
	});
	holder.current = controller;
	renderedOverlayKinds?.push(controller.state.overlay.kind);
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
		externalizeAttachments: async (messages: readonly SessionMessage[]) => ({
			messages: [...messages],
			release: async () => undefined,
		}),
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
	await act(async () => {
		await Promise.resolve();
		await setup.renderOnce();
		await Promise.resolve();
		await setup.renderOnce();
	});
};

describe("composer autocomplete", () => {
	test("keeps slash suggestions ahead of plugins and applies Plugin items", async () => {
		const provider: PluginAutocompleteProviderFactory = (current) => ({
			...current,
			getSuggestions(context) {
				if (context.text.slice(0, context.cursorOffset).endsWith("#")) {
					return {
						items: [
							{ label: "issue WCO-12", value: "WCO-12" },
							{ label: "issue WCO-13", value: "WCO-13" },
						],
						prefix: "#",
					};
				}
				return current.getSuggestions(context);
			},
		});
		const holder: { current: ChatInputController | null } = { current: null };
		const documentHolder: { current: ComposerDocument | null } = {
			current: null,
		};
		const setup = await testRenderWithClipboard(
			<ControllerProbe
				commandController={createCommandController([])}
				documentHolder={documentHolder}
				holder={holder}
				onSubmit={() => true}
				pluginAutocompleteProviders={[provider]}
				promptHistoryStore={createPromptHistoryStore([])}
				sessionId="session-1"
			/>,
			{ height: 12, width: 80 }
		);

		try {
			await waitForControllerEffects(setup);
			const setText = async (text: string): Promise<void> => {
				await act(async () => {
					const document = documentHolder.current;
					if (document === null) {
						throw new Error("expected the composer document");
					}
					const previousText = document.capture().text;
					const snapshot = document.replaceText(text, text.length);
					holder.current?.actions.onTextChange(
						snapshot,
						snapshot.cursorOffset,
						previousText
					);
				});
				await waitForControllerEffects(setup);
			};

			await setText("ask #");
			expect(holder.current?.state.overlay.kind).toBe("plugin-autocomplete");
			expect(holder.current?.state.overlay.items[0]?.label).toBe(
				"issue WCO-12"
			);
			await act(async () => {
				expect(holder.current?.actions.onArrowDown()).toBe(true);
			});
			await renderController(setup);
			expect(holder.current?.state.overlay.selectedIndex).toBe(1);
			await act(async () => holder.current?.actions.onTab(false));
			await renderController(setup);
			expect(holder.current?.state.text).toBe("ask WCO-13");

			await setText("ask #");
			await act(async () => holder.current?.actions.onEnter());
			await renderController(setup);
			expect(holder.current?.state.text).toBe("ask WCO-12");

			await setText("/rev");
			await act(async () => {
				const document = documentHolder.current;
				if (document === null) {
					throw new Error("expected the composer document");
				}
				document.replaceText("/rev", 2);
				holder.current?.actions.onCursorChange();
			});
			await waitForControllerEffects(setup);
			expect(holder.current?.state.overlay.kind).toBe("command");
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});

	test("Escape dismisses Plugin autocomplete instead of allowing stale Enter acceptance", async () => {
		const appliedValues: string[] = [];
		const provider: PluginAutocompleteProviderFactory = (current) => ({
			...current,
			getSuggestions(context) {
				if (!context.text.slice(0, context.cursorOffset).endsWith("#")) {
					return current.getSuggestions(context);
				}
				return {
					items: [{ label: "issue WCO-12", value: "WCO-12" }],
					prefix: "#",
				};
			},
			applyCompletion(context, item, prefix) {
				appliedValues.push(item.value);
				return current.applyCompletion(context, item, prefix);
			},
		});
		const holder: { current: ChatInputController | null } = { current: null };
		const documentHolder: { current: ComposerDocument | null } = {
			current: null,
		};
		const setup = await testRenderWithClipboard(
			<ControllerProbe
				commandController={createCommandController([])}
				documentHolder={documentHolder}
				holder={holder}
				onSubmit={() => true}
				pluginAutocompleteProviders={[provider]}
				promptHistoryStore={createPromptHistoryStore([])}
				sessionId="session-1"
			/>,
			{ height: 12, width: 80 }
		);

		try {
			await waitForControllerEffects(setup);
			await act(async () => {
				const document = documentHolder.current;
				if (document === null) {
					throw new Error("expected the composer document");
				}
				const previousText = document.capture().text;
				const snapshot = document.replaceText("ask #", 5);
				holder.current?.actions.onTextChange(snapshot, 5, previousText);
			});
			await waitForControllerEffects(setup);
			expect(holder.current?.state.overlay.kind).toBe("plugin-autocomplete");

			await act(async () => holder.current?.actions.onEscape());
			await renderController(setup);
			await act(async () => holder.current?.actions.onEnter());
			await renderController(setup);

			expect(holder.current?.state.text).toBe("ask #");
			expect(holder.current?.state.overlay.kind).toBe(null);
			expect(appliedValues).toEqual([]);
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});

	test("Escape prevents late Plugin autocomplete results from reopening or applying", async () => {
		const providerStarted = Promise.withResolvers<void>();
		const deferredCompletion =
			Promise.withResolvers<PluginAutocompleteResult | null>();
		const appliedValues: string[] = [];
		const provider: PluginAutocompleteProviderFactory = (current) => ({
			...current,
			getSuggestions(context) {
				if (!context.text.slice(0, context.cursorOffset).endsWith("#")) {
					return current.getSuggestions(context);
				}
				providerStarted.resolve();
				return deferredCompletion.promise;
			},
			applyCompletion(context, item, prefix) {
				appliedValues.push(item.value);
				return current.applyCompletion(context, item, prefix);
			},
		});
		const holder: { current: ChatInputController | null } = { current: null };
		const documentHolder: { current: ComposerDocument | null } = {
			current: null,
		};
		const setup = await testRenderWithClipboard(
			<ControllerProbe
				commandController={createCommandController([])}
				documentHolder={documentHolder}
				holder={holder}
				onSubmit={() => true}
				pluginAutocompleteProviders={[provider]}
				promptHistoryStore={createPromptHistoryStore([])}
				sessionId="session-1"
			/>,
			{ height: 12, width: 80 }
		);

		try {
			await waitForControllerEffects(setup);
			await act(async () => {
				const document = documentHolder.current;
				if (document === null) {
					throw new Error("expected the composer document");
				}
				const previousText = document.capture().text;
				const snapshot = document.replaceText("ask #", 5);
				holder.current?.actions.onTextChange(snapshot, 5, previousText);
			});
			await act(async () => providerStarted.promise);

			await act(async () => holder.current?.actions.onEscape());
			await renderController(setup);
			deferredCompletion.resolve({
				items: [{ label: "issue WCO-12", value: "WCO-12" }],
				prefix: "#",
			});
			await waitForControllerEffects(setup);
			await act(async () => holder.current?.actions.onEnter());
			await renderController(setup);

			expect(holder.current?.state.text).toBe("ask #");
			expect(holder.current?.state.overlay.kind).toBe(null);
			expect(appliedValues).toEqual([]);
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});

	test("unloaded Plugin autocomplete providers cannot render or apply cached suggestions", async () => {
		const appliedValues: string[] = [];
		const provider: PluginAutocompleteProviderFactory = (current) => ({
			...current,
			getSuggestions(context) {
				return context.text.slice(0, context.cursorOffset).endsWith("#")
					? {
							items: [
								{ label: "issue WCO-12", value: "WCO-12" },
								{ label: "issue WCO-13", value: "WCO-13" },
							],
							prefix: "#",
						}
					: current.getSuggestions(context);
			},
			applyCompletion(context, item, prefix) {
				appliedValues.push(item.value);
				return current.applyCompletion(context, item, prefix);
			},
		});
		const providerHolder = {
			current: [provider] as readonly PluginAutocompleteProviderFactory[],
		};
		const renderedOverlayKinds: InputOverlayState["kind"][] = [];
		const holder: { current: ChatInputController | null } = { current: null };
		const documentHolder: { current: ComposerDocument | null } = {
			current: null,
		};
		const setup = await testRenderWithClipboard(
			<ControllerProbe
				commandController={createCommandController([])}
				documentHolder={documentHolder}
				holder={holder}
				onSubmit={() => true}
				pluginAutocompleteProvidersHolder={providerHolder}
				promptHistoryStore={createPromptHistoryStore([])}
				renderedOverlayKinds={renderedOverlayKinds}
				sessionId="session-1"
			/>,
			{ height: 12, width: 80 }
		);

		try {
			await waitForControllerEffects(setup);
			await act(async () => {
				const document = documentHolder.current;
				if (document === null) {
					throw new Error("expected the composer document");
				}
				const previousText = document.capture().text;
				const snapshot = document.replaceText("ask #", 5);
				holder.current?.actions.onTextChange(snapshot, 5, previousText);
			});
			await waitForControllerEffects(setup);
			expect(holder.current?.state.overlay.kind).toBe("plugin-autocomplete");

			providerHolder.current = [];
			renderedOverlayKinds.length = 0;
			await act(async () => holder.current?.actions.onArrowDown());
			await renderController(setup);
			expect(renderedOverlayKinds).not.toContain("plugin-autocomplete");
			await act(async () => holder.current?.actions.onEnter());
			await renderController(setup);
			expect(appliedValues).toEqual([]);
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});

	test("delegates file-mention completion through a Plugin provider", async () => {
		const fileMentionOptions = Promise.withResolvers<FileMentionOption[]>();
		const provider: PluginAutocompleteProviderFactory = (current) => current;
		const holder: { current: ChatInputController | null } = { current: null };
		const documentHolder: { current: ComposerDocument | null } = {
			current: null,
		};
		const setup = await testRenderWithClipboard(
			<ControllerProbe
				commandController={createCommandController([])}
				documentHolder={documentHolder}
				getFileMentionOptions={() => fileMentionOptions.promise}
				holder={holder}
				onSubmit={() => true}
				pluginAutocompleteProviders={[provider]}
				promptHistoryStore={createPromptHistoryStore([])}
				sessionId="session-1"
			/>,
			{ height: 12, width: 80 }
		);

		try {
			await waitForControllerEffects(setup);
			const setText = async (text: string): Promise<void> => {
				await act(async () => {
					const document = documentHolder.current;
					if (document === null) {
						throw new Error("expected the composer document");
					}
					const previousText = document.capture().text;
					const snapshot = document.replaceText(text, text.length);
					holder.current?.actions.onTextChange(
						snapshot,
						snapshot.cursorOffset,
						previousText
					);
				});
				await waitForControllerEffects(setup);
			};

			await act(async () => {
				fileMentionOptions.resolve([
					{ label: "src", path: "src", type: "directory" },
					{
						label: "src/main.tsx",
						path: "src/main.tsx",
						type: "file",
					},
				]);
				await fileMentionOptions.promise;
			});
			await waitForControllerEffects(setup);
			await setText("See @src");
			let overlay = holder.current?.state.overlay;
			if (overlay?.kind !== "plugin-autocomplete") {
				throw new Error("expected Plugin-composed path suggestions");
			}
			await act(async () => {
				const document = documentHolder.current;
				if (document === null) {
					throw new Error("expected the composer document");
				}
				document.replaceText("See @src", "See @s".length);
				holder.current?.actions.onCursorChange();
			});
			await waitForControllerEffects(setup);
			overlay = holder.current?.state.overlay;
			if (overlay?.kind !== "plugin-autocomplete") {
				throw new Error(
					"expected Plugin path suggestions while caret is in the mention"
				);
			}
			const directoryIndex = overlay.items.findIndex(
				({ value }) => value === "src"
			);
			expect(directoryIndex).toBeGreaterThanOrEqual(0);
			await act(async () =>
				holder.current?.actions.onItemExecute(directoryIndex)
			);
			await waitForControllerEffects(setup);
			expect(holder.current?.state.text).toBe("See @src");
			expect(holder.current?.state.overlay.kind).toBe("plugin-autocomplete");

			await setText("See @src/ma");
			overlay = holder.current?.state.overlay;
			if (overlay?.kind !== "plugin-autocomplete") {
				throw new Error("expected nested Plugin-composed path suggestions");
			}
			const fileIndex = overlay.items.findIndex(
				({ value }) => value === "src/main.tsx"
			);
			expect(fileIndex).toBeGreaterThanOrEqual(0);
			await act(async () => holder.current?.actions.onItemExecute(fileIndex));
			await renderController(setup);
			expect(holder.current?.state.text).toBe("See @src/main.tsx ");
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});

	test("moving the caret away from a file mention prevents Enter replacing it", async () => {
		const fileMentionOptions = Promise.withResolvers<FileMentionOption[]>();
		const holder: { current: ChatInputController | null } = { current: null };
		const documentHolder: { current: ComposerDocument | null } = {
			current: null,
		};
		const setup = await testRenderWithClipboard(
			<ControllerProbe
				commandController={createCommandController([])}
				documentHolder={documentHolder}
				getFileMentionOptions={() => fileMentionOptions.promise}
				holder={holder}
				onSubmit={() => true}
				promptHistoryStore={createPromptHistoryStore([])}
			/>,
			{ height: 12, width: 80 }
		);

		try {
			await waitForControllerEffects(setup);
			await act(async () => {
				fileMentionOptions.resolve([
					{ label: "src/main.tsx", path: "src/main.tsx", type: "file" },
				]);
				await fileMentionOptions.promise;
			});
			await waitForControllerEffects(setup);
			const text = "See @src now";
			const mentionCursorOffset = text.indexOf("@src") + "@src".length;
			await act(async () => {
				const document = documentHolder.current;
				if (document === null) {
					throw new Error("expected the composer document");
				}
				const snapshot = document.replaceText(text, mentionCursorOffset);
				holder.current?.actions.onTextChange(snapshot, mentionCursorOffset, "");
			});
			await waitForControllerEffects(setup);
			expect(holder.current?.state.overlay.kind).toBe("file-mention");

			await act(async () => {
				const document = documentHolder.current;
				if (document === null) {
					throw new Error("expected the composer document");
				}
				document.replaceText(text, text.indexOf("@"));
				holder.current?.actions.onCursorChange();
			});
			await renderController(setup);
			const overlayAfterMovingCaret = holder.current?.state.overlay;
			await act(async () => holder.current?.actions.onEnter());
			await renderController(setup);

			expect(holder.current?.state.text).toBe(text);
			expect(overlayAfterMovingCaret?.kind).toBe(null);
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});

	test("ignores a late file-mention Plugin completion after the caret leaves its range", async () => {
		const fileMentionOptions = Promise.withResolvers<FileMentionOption[]>();
		const providerStarted = Promise.withResolvers<void>();
		const deferredCompletion =
			Promise.withResolvers<PluginAutocompleteResult | null>();
		const provider: PluginAutocompleteProviderFactory = (current) => ({
			...current,
			getSuggestions(context) {
				if (context.text.slice(0, context.cursorOffset).endsWith("@src")) {
					providerStarted.resolve();
					return deferredCompletion.promise;
				}
				return current.getSuggestions(context);
			},
		});
		const holder: { current: ChatInputController | null } = { current: null };
		const documentHolder: { current: ComposerDocument | null } = {
			current: null,
		};
		const setup = await testRenderWithClipboard(
			<ControllerProbe
				commandController={createCommandController([])}
				documentHolder={documentHolder}
				getFileMentionOptions={() => fileMentionOptions.promise}
				holder={holder}
				onSubmit={() => true}
				pluginAutocompleteProviders={[provider]}
				promptHistoryStore={createPromptHistoryStore([])}
				sessionId="session-1"
			/>,
			{ height: 12, width: 80 }
		);

		try {
			await waitForControllerEffects(setup);
			await act(async () => {
				fileMentionOptions.resolve([
					{ label: "src/main.tsx", path: "src/main.tsx", type: "file" },
				]);
				await fileMentionOptions.promise;
			});
			await waitForControllerEffects(setup);

			const text = "Mention @src here";
			const mentionCursorOffset = "Mention @src".length;
			await act(async () => {
				const document = documentHolder.current;
				if (document === null) {
					throw new Error("expected the composer document");
				}
				const snapshot = document.replaceText(text, mentionCursorOffset);
				holder.current?.actions.onTextChange(snapshot, mentionCursorOffset, "");
			});
			await waitForControllerEffects(setup);
			await act(async () => {
				await providerStarted.promise;
			});
			expect(holder.current?.state.overlay.kind).toBe("file-mention");

			await act(async () => {
				const document = documentHolder.current;
				if (document === null) {
					throw new Error("expected the composer document");
				}
				document.replaceText(text, text.indexOf("@"));
				holder.current?.actions.onCursorChange();
			});
			await waitForControllerEffects(setup);
			expect(holder.current?.state.overlay.kind).toBe(null);

			await act(async () => {
				deferredCompletion.resolve({
					items: [{ label: "src/main.tsx", value: "src/main.tsx" }],
					prefix: "@src",
				});
				await deferredCompletion.promise;
			});
			await waitForControllerEffects(setup);
			expect(holder.current?.state.overlay.kind).toBe(null);

			await act(async () => holder.current?.actions.onEnter());
			await renderController(setup);
			expect(holder.current?.state.text).toBe(text);
			expect(holder.current?.state.overlay.kind).toBe(null);
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});

	test("shows and applies Plugin Command argument completions", async () => {
		const holder: { current: ChatInputController | null } = { current: null };
		const documentHolder: { current: ComposerDocument | null } = {
			current: null,
		};
		const commandController = createCommandController(
			[],
			async (text, cursorOffset) => {
				const tokenStart = text.lastIndexOf(" ", cursorOffset - 1) + 1;
				const prefix = text.slice(tokenStart, cursorOffset);
				return text.startsWith("/deploy ")
					? {
							commandName: "deploy",
							items: [{ label: "staging", value: "staging" }],
							pluginId: "plugin_deploy",
							prefix,
						}
					: null;
			}
		);
		const setup = await testRenderWithClipboard(
			<ControllerProbe
				commandController={commandController}
				documentHolder={documentHolder}
				holder={holder}
				onSubmit={() => true}
				promptHistoryStore={createPromptHistoryStore([])}
				sessionId="session-1"
			/>,
			{ height: 12, width: 80 }
		);

		try {
			await waitForControllerEffects(setup);
			await act(async () => {
				const document = documentHolder.current;
				if (document === null) {
					throw new Error("expected the composer document");
				}
				const text = "/deploy sta";
				const snapshot = document.replaceText(text, text.length);
				holder.current?.actions.onTextChange(snapshot, text.length, "");
			});
			await waitForControllerEffects(setup);
			expect(holder.current?.state.overlay.kind).toBe("plugin-argument");
			expect(holder.current?.state.overlay.items[0]?.label).toBe("staging");
			await act(async () => holder.current?.actions.onItemExecute(0));
			await renderController(setup);
			expect(holder.current?.state.text).toBe("/deploy staging");
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});

	test("does not apply cached Plugin Command suggestions after unload", async () => {
		let pluginCommandActive = true;
		const holder: { current: ChatInputController | null } = { current: null };
		const documentHolder: { current: ComposerDocument | null } = {
			current: null,
		};
		const commandController = createCommandController(
			[],
			async (text, cursorOffset) => {
				const tokenStart = text.lastIndexOf(" ", cursorOffset - 1) + 1;
				const prefix = text.slice(tokenStart, cursorOffset);
				return text.startsWith("/deploy ")
					? {
							commandName: "deploy",
							items: [{ label: "staging", value: "staging" }],
							pluginId: "plugin_deploy",
							prefix,
						}
					: null;
			},
			() => pluginCommandActive
		);
		const setup = await testRenderWithClipboard(
			<ControllerProbe
				commandController={commandController}
				documentHolder={documentHolder}
				holder={holder}
				onSubmit={() => true}
				promptHistoryStore={createPromptHistoryStore([])}
				sessionId="session-1"
			/>,
			{ height: 12, width: 80 }
		);

		try {
			await waitForControllerEffects(setup);
			await act(async () => {
				const document = documentHolder.current;
				if (document === null) {
					throw new Error("expected the composer document");
				}
				const text = "/deploy sta";
				const snapshot = document.replaceText(text, text.length);
				holder.current?.actions.onTextChange(snapshot, text.length, "");
			});
			await waitForControllerEffects(setup);
			expect(holder.current?.state.overlay.kind).toBe("plugin-argument");

			pluginCommandActive = false;
			await act(async () => holder.current?.actions.onEnter());
			await renderController(setup);

			expect(holder.current?.state.text).toBe("/deploy sta");
			expect(holder.current?.state.overlay.kind).toBe(null);
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});
});

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
