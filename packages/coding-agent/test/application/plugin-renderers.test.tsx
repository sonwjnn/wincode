import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type {
	PluginEntryRenderer,
	PluginFactory,
	PluginMessageRenderer,
	PluginSessionHistory,
	PluginSessionHistoryEntry,
	PluginUIContributionResult,
} from "@wincode/coding-agent";
import { act, createElement, useEffect } from "react";
import { loadPlugins } from "@/modules/plugins/loader";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import { rebuildUneditedSessionContext } from "@/modules/sessions/context-projection";
import {
	filterSessionMessagesForActiveContext,
	type SessionMessage,
} from "@/modules/sessions/message";
import type {
	SessionHistoryTreePage,
	SessionHistoryTreePluginEntry,
} from "@/modules/sessions/session-pagination-types";
import type { PluginSessionHistoryPersistence } from "@/modules/sessions/session-plugin-history";
import { ChatMessage } from "@/modules/sessions/ui/components/chat-message";
import { SessionHistoryTreeDialogContent } from "@/modules/sessions/ui/dialogs/session-history-tree-dialog";
import { createConfigStore } from "@/shared/config/config-store";
import { toSessionHistoryEntryId, toSessionId } from "@/shared/identifiers";
import {
	DialogProvider,
	useDialog,
} from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import { setInteractiveRuntimeContext } from "@/shared/runtime-context";
import historyEntryRendererPlugin from "../../examples/history-entry-renderer-plugin";
import { testRenderWithClipboard } from "../support/clipboard";
import { sessionMessageId } from "../support/identifiers";
import { captureTestFrame, flushTestRenderer } from "../support/opentui";
import { successfulSessionWriteOutcome } from "../support/session-facets";

const FirstMessageRenderer: PluginMessageRenderer = ({ message }) => {
	void message;
	return null;
};

const SecondMessageRenderer: PluginMessageRenderer = ({ message }) => {
	void message;
	return null;
};

const FirstEntryRenderer: PluginEntryRenderer = ({ entry }) => {
	void entry;
	return null;
};

const SecondEntryRenderer: PluginEntryRenderer = ({ entry }) => {
	void entry;
	return null;
};

const withPluginRuntime = async (
	factories: readonly Readonly<{ factory: PluginFactory; id: string }>[],
	action: (runtime: PluginRuntime) => Promise<void>
): Promise<void> => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-renderer-api-"));
	const workspace = path.join(root, "workspace");
	await fs.mkdir(workspace, { recursive: true });
	const configStore = createConfigStore({
		homeRoot: root,
		trustedProjectRoots: [workspace],
	});
	const runtime = await loadPlugins({
		bundledPlugins: factories,
		cliPaths: [],
		config: {
			configStore,
			cwd: workspace,
			homeRoot: root,
			trustedProjectRoots: [workspace],
			workspace,
		},
		userDataDir: root,
	});
	try {
		await action(runtime);
	} finally {
		await runtime.shutdown();
		await fs.rm(root, { force: true, recursive: true });
	}
};

test("renderer registration keeps role ownership and Plugin-local entry types distinct", async () => {
	const results: PluginUIContributionResult[] = [];
	const firstPlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "first_renderer" });
		results.push(
			api.registerMessageRenderer("assistant", FirstMessageRenderer)
		);
		results.push(api.registerEntryRenderer("status", FirstEntryRenderer));
	};
	const secondPlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "second_renderer" });
		results.push(
			api.registerMessageRenderer("assistant", SecondMessageRenderer)
		);
		results.push(api.registerEntryRenderer("status", SecondEntryRenderer));
	};

	await withPluginRuntime(
		[
			{ factory: firstPlugin, id: "first_renderer" },
			{ factory: secondPlugin, id: "second_renderer" },
		],
		async (runtime) => {
			expect(results).toEqual([
				{ success: true },
				{ success: true },
				{
					code: "plugin_ui_contribution_conflict",
					success: false,
					surface: "message",
				},
				{ success: true },
			]);
			expect(runtime.getMessageRenderer("assistant")?.pluginId).toBe(
				"first_renderer"
			);
			expect(
				runtime.getEntryRenderer("first_renderer", "status")?.component
			).toBe(FirstEntryRenderer);
			expect(
				runtime.getEntryRenderer("second_renderer", "status")?.component
			).toBe(SecondEntryRenderer);
			runtime.disablePlugin("first_renderer", "Renderer owner unloaded.");
			expect(runtime.getMessageRenderer("assistant")).toBeUndefined();
		}
	);
});

test("the history-entry renderer example displays versioned Plugin history", async () => {
	const entry: PluginSessionHistoryEntry = {
		createdAt: new Date("2026-02-03T04:05:06.000Z"),
		id: toSessionHistoryEntryId("history-entry-example-test"),
		parentEntryId: null,
		payload: {
			message: "Remember to file the release note.",
			schemaVersion: 1,
		},
		sequence: 7,
		type: "note-added",
	};
	await withPluginRuntime(
		[{ factory: historyEntryRendererPlugin, id: "history_entry_renderer" }],
		async (runtime) => {
			const contribution = runtime.getEntryRenderer(
				"history_entry_renderer",
				entry.type
			);
			if (contribution === undefined) {
				throw new Error(
					"The history-entry example did not register its renderer."
				);
			}
			const setup = await testRender(
				<ThemeProvider themeName={DEFAULT_THEME.name}>
					{createElement(contribution.component, {
						dimensions: { height: 10, width: 48 },
						entry,
						options: { selectedPath: true },
						theme: DEFAULT_THEME,
					})}
				</ThemeProvider>,
				{ height: 10, width: 48 }
			);
			try {
				await flushTestRenderer(setup, 2);
				expect(captureTestFrame(setup)).toContain(
					"Note · entry 7 · Selected Path"
				);
				expect(captureTestFrame(setup)).toContain(
					"Remember to file the release note."
				);
			} finally {
				await act(async () => {
					setup.renderer.destroy();
					await setup.renderer.closed;
				});
			}
		}
	);
});

test("a Plugin presents Session Transcript messages without changing their model input", async () => {
	let presentedMessage: SessionMessage | undefined;
	const rendererLifecycle = { mounted: 0, unmounted: 0 };
	const renderer: PluginMessageRenderer = ({
		dimensions,
		message,
		options,
		theme,
	}) => {
		presentedMessage = message;
		useEffect(() => {
			rendererLifecycle.mounted += 1;
			return () => {
				rendererLifecycle.unmounted += 1;
			};
		}, []);
		return (
			<text>{`presented:${message.role}:${theme.name}:${dimensions.width}:${options.streaming}`}</text>
		);
	};
	const plugin: PluginFactory = (api) => {
		api.definePlugin({ id: "transcript_renderer" });
		api.registerMessageRenderer("assistant", renderer);
	};

	await withPluginRuntime(
		[{ factory: plugin, id: "transcript_renderer" }],
		async (runtime) => {
			const message: SessionMessage = {
				id: sessionMessageId("assistant-renderer-test"),
				parts: [{ text: "durable assistant text", type: "text" }],
				role: "assistant",
			};
			const modelInput = filterSessionMessagesForActiveContext([message]);
			setInteractiveRuntimeContext({
				args: [],
				cwd: "/workspace",
				pluginRuntime: runtime,
			});
			const setup = await testRender(
				<ThemeProvider themeName="opencode">
					<text>host-test-frame</text>
					<ChatMessage messages={[message]} sessionId="rendered-session" />
				</ThemeProvider>,
				{ height: 12, width: 64 }
			);
			try {
				await flushTestRenderer(setup, 2);
				const frame = captureTestFrame(setup) ?? "";
				expect(frame).toContain("host-test-frame");
				expect(frame).toContain("presented:assistant:opencode:64:false");
				expect(frame).not.toContain("durable assistant text");
				expect(presentedMessage).toBe(message);
				expect(filterSessionMessagesForActiveContext([message])).toEqual(
					modelInput
				);
				await act(async () => {
					runtime.disablePlugin("transcript_renderer", "Renderer unloaded.");
					await flushTestRenderer(setup, 2);
				});
				expect(captureTestFrame(setup)).not.toContain(
					"presented:assistant:opencode:64:false"
				);
				expect(rendererLifecycle).toEqual({ mounted: 1, unmounted: 1 });
			} finally {
				await act(async () => {
					setup.renderer.destroy();
					await setup.renderer.closed;
				});
				setInteractiveRuntimeContext({ args: [], cwd: "/workspace" });
			}
		}
	);
});

test("a rendered Plugin history payload remains excluded from Session Context", async () => {
	const previewSessionId = toSessionId("plugin-entry-preview-session");
	const persistedEntry: PluginSessionHistoryEntry = {
		createdAt: new Date("2026-01-02T03:04:05.000Z"),
		id: toSessionHistoryEntryId("plugin-entry-preview-entry"),
		parentEntryId: null,
		payload: { label: "restored", privateNote: "plugin-history-payload-only" },
		sequence: 1,
		type: "status",
	};
	const treeEntry: SessionHistoryTreePluginEntry = {
		createdAt: persistedEntry.createdAt,
		id: persistedEntry.id,
		kind: "plugin-entry",
		parentEntryId: null,
		pluginId: "history_renderer",
		selectedPath: true,
		sequence: persistedEntry.sequence,
		type: persistedEntry.type,
	};
	const inactiveTreeEntry: SessionHistoryTreePluginEntry = {
		...treeEntry,
		id: toSessionHistoryEntryId("plugin-entry-preview-inactive"),
		parentEntryId: treeEntry.id,
		selectedPath: false,
		sequence: 2,
	};
	const missingPluginTreeEntry: SessionHistoryTreePluginEntry = {
		...inactiveTreeEntry,
		id: toSessionHistoryEntryId("plugin-entry-preview-missing-plugin"),
		parentEntryId: inactiveTreeEntry.id,
		pluginId: "not_loaded",
		selectedPath: true,
		sequence: 3,
		type: "opaque-status",
	};
	const unsupportedEntry: PluginSessionHistoryEntry = {
		...persistedEntry,
		id: toSessionHistoryEntryId("plugin-entry-preview-unsupported"),
		parentEntryId: persistedEntry.id,
		payload: { schemaVersion: 99 },
		sequence: 4,
	};
	const unsupportedTreeEntry: SessionHistoryTreePluginEntry = {
		...treeEntry,
		id: unsupportedEntry.id,
		parentEntryId: missingPluginTreeEntry.id,
		sequence: unsupportedEntry.sequence,
	};
	const navigatedEntry: PluginSessionHistoryEntry = {
		...persistedEntry,
		id: inactiveTreeEntry.id,
		parentEntryId: persistedEntry.id,
		payload: { label: "after navigation" },
		sequence: inactiveTreeEntry.sequence,
	};
	const transcriptMessage: SessionMessage = {
		id: sessionMessageId("plugin-entry-session-context-test"),
		parts: [{ text: "Prepare a release note.", type: "text" }],
		role: "user",
	};
	const renderer: PluginEntryRenderer = ({ entry }) => {
		const payload = entry.payload;
		const label =
			typeof payload === "object" && payload !== null && "label" in payload
				? payload.label
				: "unsupported";
		if (label === "unsupported") {
			throw new Error("The renderer does not support this payload version.");
		}
		return <text>{`plugin-rendered:${entry.type}:${String(label)}`}</text>;
	};
	let pluginHistory: PluginSessionHistory | undefined;
	const plugin: PluginFactory = (api) => {
		const definition = api.definePlugin({ id: "history_renderer" });
		definition.onSessionStart(({ sessionHistory }) => {
			if (sessionHistory === undefined) {
				throw new Error("The Plugin Session History capability is missing.");
			}
			pluginHistory = sessionHistory;
		});
		api.registerEntryRenderer("status", renderer);
	};
	const readCursors: Array<string | undefined> = [];
	let activeLeafId = unsupportedTreeEntry.id;
	let historyGeneration = 0;
	let currentHistoryEntries = [unsupportedEntry];
	const historyPersistence: PluginSessionHistoryPersistence = {
		append: async (_pluginId, input) => {
			const entry: PluginSessionHistoryEntry = {
				...persistedEntry,
				payload: input.payload,
				type: input.type,
			};
			currentHistoryEntries = [
				entry,
				...currentHistoryEntries.filter(({ id }) => id !== entry.id),
			];
			return {
				entryId: entry.id,
				writeOutcome: successfulSessionWriteOutcome(
					input.operationId,
					entry.sequence
				),
			};
		},
		read: async (_pluginId, options) => {
			readCursors.push(options?.cursor);
			const readPoint = `history-snapshot-${historyGeneration}`;
			return options?.cursor === "older"
				? { entries: currentHistoryEntries, readPoint }
				: { entries: [], nextCursor: "older", readPoint };
		},
	};

	await withPluginRuntime(
		[{ factory: plugin, id: "history_renderer" }],
		async (runtime) => {
			await runtime.startSession(
				{
					executionMode: "interactive",
					sessionId: previewSessionId,
					workspace: "/workspace",
				},
				undefined,
				historyPersistence
			);
			const history = pluginHistory;
			if (history === undefined) {
				throw new Error("The Plugin Session History capability is missing.");
			}
			expect(
				await history.append(
					persistedEntry.type,
					persistedEntry.payload,
					"plugin-history-renderer-write"
				)
			).toBe(persistedEntry.id);
			setInteractiveRuntimeContext({
				args: [],
				cwd: "/workspace",
				pluginRuntime: runtime,
			});
			const createTreePage = (): SessionHistoryTreePage => ({
				activeLeafId,
				entries: [
					{ ...treeEntry, selectedPath: true },
					{
						...inactiveTreeEntry,
						selectedPath: activeLeafId === inactiveTreeEntry.id,
					},
					{
						...missingPluginTreeEntry,
						selectedPath: activeLeafId === unsupportedTreeEntry.id,
					},
					{
						...unsupportedTreeEntry,
						selectedPath: activeLeafId === unsupportedTreeEntry.id,
					},
				],
				historyGeneration,
				readPoint: `tree-snapshot-${historyGeneration}`,
			});
			const treePage = createTreePage();
			const pendingTreePage = Promise.withResolvers<SessionHistoryTreePage>();
			let firstTreePageRead = true;
			const sessionSdk = {
				navigateSessionHistory: async (
					_sessionId: string,
					options: Readonly<{ targetEntryId: string | null }>
				) => {
					if (options.targetEntryId !== inactiveTreeEntry.id) {
						return { activeLeafId, kind: "unchanged" as const };
					}
					const fromEntryId = activeLeafId;
					activeLeafId = inactiveTreeEntry.id;
					historyGeneration += 1;
					currentHistoryEntries = [persistedEntry, navigatedEntry];
					const operationId = "history-preview-navigation";
					await runtime.notifySessionHistoryNavigated?.({
						executionMode: "interactive",
						fromEntryId,
						historyGeneration,
						operationId,
						sessionId: previewSessionId,
						toEntryId: activeLeafId,
						workspace: "/workspace",
					});
					return {
						activeLeafId,
						kind: "navigated" as const,
						writeOutcome: {
							entryHash: "history-preview-navigation-hash",
							kind: "committed" as const,
							operationId,
							projection: "ready" as const,
							sequence: historyGeneration + 1,
						},
					};
				},
				readSessionHistoryTreePage: () => {
					if (firstTreePageRead) {
						firstTreePageRead = false;
						return pendingTreePage.promise;
					}
					return Promise.resolve(createTreePage());
				},
			};
			let reopenHistoryTree: (() => void) | undefined;
			function HistoryTreeHarness() {
				const { open } = useDialog();
				useEffect(() => {
					const showHistoryTree = (): void => {
						open({
							children: (
								<SessionHistoryTreeDialogContent
									sessionId={previewSessionId}
									sessionSdk={sessionSdk}
								/>
							),
							title: "Session history",
							width: 72,
						});
					};
					reopenHistoryTree = showHistoryTree;
					showHistoryTree();
					return () => {
						reopenHistoryTree = undefined;
					};
				}, [open]);
				return null;
			}
			const setup = await testRenderWithClipboard(
				<ThemeProvider themeName={DEFAULT_THEME.name}>
					<KeyboardLayerProvider>
						<DialogProvider>
							<HistoryTreeHarness />
						</DialogProvider>
					</KeyboardLayerProvider>
				</ThemeProvider>,
				{ height: 18, kittyKeyboard: true, width: 64 }
			);
			try {
				await act(async () => {
					pendingTreePage.resolve(treePage);
					await flushTestRenderer(setup, 2);
				});
				for (let index = 0; index < 3; index += 1) {
					await act(() => setup.mockInput.pressArrow("up"));
				}
				await act(() => setup.mockInput.pressKey("p"));
				await flushTestRenderer(setup, 3);
				expect(setup.captureCharFrame()).toContain(
					"plugin-rendered:status:restored"
				);
				const sessionContext = rebuildUneditedSessionContext(
					[transcriptMessage],
					[]
				);
				expect(sessionContext).toEqual([transcriptMessage]);
				expect(JSON.stringify(sessionContext)).not.toContain(
					"plugin-history-payload-only"
				);
				expect(JSON.stringify(sessionContext)).not.toContain(
					"plugin-rendered:status:restored"
				);
				expect(readCursors).toEqual([undefined, "older"]);
				expect(await history.read({ cursor: "older" })).toMatchObject({
					entries: [persistedEntry, unsupportedEntry],
				});
				const readsBeforeFallback = [...readCursors];
				await act(() => setup.mockInput.pressEscape());
				await flushTestRenderer(setup, 2);
				await act(() => setup.mockInput.pressArrow("down"));
				await act(() => setup.mockInput.pressKey("p"));
				await flushTestRenderer(setup, 2);
				expect(setup.captureCharFrame()).toContain(
					"Plugin history payload is intentionally hidden"
				);
				expect(readCursors).toEqual(readsBeforeFallback);
				await act(() => setup.mockInput.pressEscape());
				await flushTestRenderer(setup, 2);
				await act(() => setup.mockInput.pressArrow("down"));
				await act(() => setup.mockInput.pressKey("p"));
				await flushTestRenderer(setup, 2);
				expect(setup.captureCharFrame()).toContain(
					"Plugin history payload is intentionally hidden"
				);
				expect(readCursors).toEqual(readsBeforeFallback);
				await act(() => setup.mockInput.pressEscape());
				await flushTestRenderer(setup, 2);
				await act(() => setup.mockInput.pressArrow("down"));
				await act(() => setup.mockInput.pressKey("p"));
				await flushTestRenderer(setup, 3);
				expect(setup.captureCharFrame()).toContain(
					"Plugin history payload is intentionally hidden"
				);
				const storedPage = await history.read({ cursor: "older" });
				expect(storedPage?.entries).toEqual([persistedEntry, unsupportedEntry]);
				await act(() => setup.mockInput.pressEscape());
				await flushTestRenderer(setup, 2);
				await act(() => setup.mockInput.pressArrow("up"));
				await act(() => setup.mockInput.pressArrow("up"));
				await act(() => setup.mockInput.pressEnter());
				await flushTestRenderer(setup, 3);
				if (reopenHistoryTree === undefined) {
					throw new Error("The history tree could not be reopened.");
				}
				await act(async () => {
					reopenHistoryTree?.();
					await flushTestRenderer(setup, 3);
				});
				await act(() => setup.mockInput.pressKey("p"));
				await flushTestRenderer(setup, 3);
				expect(setup.captureCharFrame()).toContain(
					"plugin-rendered:status:after navigation"
				);
				const navigatedHistory = runtime.getSessionHistoryForPlugin(
					"history_renderer",
					previewSessionId
				);
				expect(await navigatedHistory?.read({ cursor: "older" })).toMatchObject(
					{
						entries: [persistedEntry, navigatedEntry],
					}
				);
			} finally {
				await act(async () => {
					setup.renderer.destroy();
					await setup.renderer.closed;
				});
				setInteractiveRuntimeContext({ args: [], cwd: "/workspace" });
			}
		}
	);
});
