import { afterEach, expect, test } from "bun:test";
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
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import {
	filterSessionMessagesForActiveContext,
	type SessionMessage,
} from "@/modules/sessions/message";
import { createSessionSdkWithRuntime } from "@/modules/sessions/sdk";
import type {
	SessionSdk,
	SessionSdkHandle,
} from "@/modules/sessions/sdk-contract";
import type {
	SessionHistoryTreePage,
	SessionHistoryTreePluginEntry,
} from "@/modules/sessions/session-pagination-types";
import type { PluginSessionHistoryPersistence } from "@/modules/sessions/session-plugin-history";
import { ChatMessage } from "@/modules/sessions/ui/components/chat-message";
import { SessionHistoryTreeDialogContent } from "@/modules/sessions/ui/dialogs/session-history-tree-dialog";
import { createConfigStore } from "@/shared/config/config-store";
import { type SessionId, toSessionHistoryEntryId } from "@/shared/identifiers";
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
import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
} from "../support/e2e-fake-runtime";
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

const activeSessionFixtureCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	await Promise.all(
		activeSessionFixtureCleanups.splice(0).map((cleanup) => cleanup())
	);
});

const createActiveSessionPluginHistory = async (): Promise<{
	history: PluginSessionHistory;
	persistedEntry: PluginSessionHistoryEntry;
	readContext: () => readonly object[];
	sessionId: SessionId;
}> => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "plugin-renderer-active-session-")
	);
	const workspace = path.join(root, "workspace");
	await fs.mkdir(workspace, { recursive: true });
	let sdk: SessionSdk | undefined;
	let handle: SessionSdkHandle | undefined;
	let sessionHistory: PluginSessionHistory | undefined;
	const dispose = async (): Promise<void> => {
		try {
			await handle?.dispose();
		} finally {
			try {
				await sdk?.dispose();
			} finally {
				await fs.rm(root, { force: true, recursive: true });
			}
		}
	};
	const pluginFactory: PluginFactory = (api) => {
		const definition = api.definePlugin({ id: "history_renderer" });
		definition.onSessionStart(({ sessionHistory: activeHistory }) => {
			if (activeHistory === undefined) {
				throw new Error("The Plugin Session History capability is missing.");
			}
			sessionHistory = activeHistory;
		});
	};
	const recorder = createFakeProviderRecorder();
	try {
		sdk = await createSessionSdkWithRuntime({
			createProviderCollection: () => createFakeProviderCollection(recorder),
			cwd: workspace,
			databasePath: path.join(root, "sessions.sqlite"),
			pluginFactories: [{ factory: pluginFactory, id: "history_renderer" }],
			pluginPaths: [],
			workspace,
		});
		const sessionId = await sdk.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		handle = await sdk.openSession(sessionId, { autoContinue: false });
		const activeHandle = handle;
		const turnCompleted = Promise.withResolvers<boolean>();
		const unsubscribeTurn = activeHandle.onEvent((event) => {
			if (
				event.type === "agent-turn-completed" ||
				event.type === "agent-turn-failed"
			) {
				turnCompleted.resolve(event.type === "agent-turn-completed");
			}
		});
		try {
			expect(
				(
					await activeHandle.deliver({
						idempotencyKey: "plugin-renderer-active-session-turn",
						text: "Prepare a release note.",
					})
				).rejected
			).toBe(false);
			expect(await turnCompleted.promise).toBe(true);
		} finally {
			unsubscribeTurn();
		}
		const history = sessionHistory;
		if (history === undefined) {
			throw new Error("The Plugin Session History capability is missing.");
		}
		const entryId = await history.append(
			"status",
			{ label: "restored", privateNote: "plugin-history-payload-only" },
			"plugin-renderer-active-session-history-write"
		);
		const historyPage = await history.read({ limit: 20 });
		const persistedEntry = historyPage.entries.find(({ id }) => id === entryId);
		if (persistedEntry === undefined) {
			throw new Error("The Plugin Session History entry was not persisted.");
		}
		const followupTurnCompleted = Promise.withResolvers<boolean>();
		const unsubscribeFollowupTurn = activeHandle.onEvent((event) => {
			if (
				event.type === "agent-turn-completed" ||
				event.type === "agent-turn-failed"
			) {
				followupTurnCompleted.resolve(event.type === "agent-turn-completed");
			}
		});
		try {
			expect(
				(
					await activeHandle.deliver({
						idempotencyKey: "plugin-renderer-active-session-followup-turn",
						text: "Write a release note update.",
					})
				).rejected
			).toBe(false);
			expect(await followupTurnCompleted.promise).toBe(true);
		} finally {
			unsubscribeFollowupTurn();
		}
		const readContext = (): readonly object[] => {
			let context: readonly object[] | undefined;
			const unsubscribe = activeHandle.subscribe((snapshot) => {
				context = snapshot.context;
			});
			unsubscribe();
			if (context === undefined) {
				throw new Error("The active Session did not publish its context.");
			}
			return context;
		};
		activeSessionFixtureCleanups.push(dispose);
		return { history, persistedEntry, readContext, sessionId };
	} catch (error) {
		await dispose();
		throw error;
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
	const {
		history: activeHistory,
		persistedEntry,
		readContext,
		sessionId: previewSessionId,
	} = await createActiveSessionPluginHistory();
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
		sequence: persistedEntry.sequence + 1,
	};
	const missingPluginTreeEntry: SessionHistoryTreePluginEntry = {
		...inactiveTreeEntry,
		id: toSessionHistoryEntryId("plugin-entry-preview-missing-plugin"),
		parentEntryId: inactiveTreeEntry.id,
		pluginId: "not_loaded",
		selectedPath: true,
		sequence: inactiveTreeEntry.sequence + 1,
		type: "opaque-status",
	};
	const unsupportedEntry: PluginSessionHistoryEntry = {
		...persistedEntry,
		id: toSessionHistoryEntryId("plugin-entry-preview-unsupported"),
		parentEntryId: persistedEntry.id,
		payload: { schemaVersion: 99 },
		sequence: missingPluginTreeEntry.sequence + 1,
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
	let renderedEntry: PluginSessionHistoryEntry | undefined;
	const renderer: PluginEntryRenderer = ({ entry }) => {
		renderedEntry = entry;
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
	const plugin: PluginFactory = (api) => {
		api.definePlugin({ id: "history_renderer" });
		api.registerEntryRenderer("status", renderer);
	};
	const readCursors: Array<string | undefined> = [];
	let activeHistoryPreviewReads = 0;
	const readActiveHistory: PluginSessionHistory["read"] = async (options) => {
		activeHistoryPreviewReads += 1;
		return activeHistory.read(options);
	};
	let activeLeafId = unsupportedTreeEntry.id;
	let historyGeneration = 0;
	let activeHistoryReadPoint: string | undefined;
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
			if (options?.cursor === "older") {
				if (activeHistoryReadPoint === undefined) {
					throw new Error("The active Plugin history page was not read first.");
				}
				return {
					entries:
						historyGeneration > 0
							? currentHistoryEntries
							: [persistedEntry, unsupportedEntry],
					readPoint: activeHistoryReadPoint,
				};
			}
			const activePage = await readActiveHistory(options);
			activeHistoryReadPoint = `${activePage.readPoint}:${historyGeneration}`;
			return {
				...activePage,
				entries:
					historyGeneration > 0 ? currentHistoryEntries : activePage.entries,
				nextCursor: activePage.nextCursor ?? "older",
				readPoint: activeHistoryReadPoint,
			};
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
				expect(renderedEntry).toEqual(persistedEntry);
				const sessionContext = readContext();
				const serializedContext = JSON.stringify(sessionContext);
				expect(serializedContext).toContain("Prepare a release note.");
				expect(serializedContext).toContain("Write a release note update.");
				expect(serializedContext).not.toContain(
					JSON.stringify(persistedEntry.payload)
				);
				expect(serializedContext).not.toContain("plugin-history-payload-only");
				expect(serializedContext).not.toContain(
					"plugin-rendered:status:restored"
				);
				expect(activeHistoryPreviewReads).toBeGreaterThan(0);
				expect(readCursors).toEqual([undefined]);
				const previewHistory = runtime.getSessionHistoryForPlugin(
					"history_renderer",
					previewSessionId
				);
				expect(await previewHistory?.read({ cursor: "older" })).toMatchObject({
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
				const storedPage = await previewHistory?.read({ cursor: "older" });
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
