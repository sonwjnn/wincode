import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type {
	PluginEntryRenderer,
	PluginEntryRendererContext,
	PluginFactory,
	PluginMessageRenderer,
	PluginMessageRendererContext,
	PluginSessionHistory,
	PluginSessionHistoryEntry,
	PluginUIContributionResult,
} from "@wincode/coding-agent";
import { act, useEffect } from "react";
import { loadPlugins } from "@/modules/plugins/loader";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import { PluginRendererResolution } from "@/modules/plugins/ui/plugin-renderer-boundary";
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
import pluginRendererCompositionExample from "../../examples/plugin-renderer-composition";
import { testRenderWithClipboard } from "../support/clipboard";
import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
} from "../support/e2e-fake-runtime";
import { sessionMessageId } from "../support/identifiers";
import { captureTestFrame, flushTestRenderer } from "../support/opentui";
import { successfulSessionWriteOutcome } from "../support/session-facets";

const FirstMessageRenderer: PluginMessageRenderer = (context) => (
	<text>{`first:${context.role}`}</text>
);

const SecondMessageRenderer: PluginMessageRenderer = (context) => (
	<text>{`second:${context.role}`}</text>
);

const FirstEntryRenderer: PluginEntryRenderer = (context) => (
	<text>{`first:${context.originPluginId}:${context.type}`}</text>
);

const SecondEntryRenderer: PluginEntryRenderer = (context) => (
	<text>{`second:${context.originPluginId}:${context.type}`}</text>
);

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
	let sdk: SessionSdk | undefined;
	let handle: SessionSdkHandle | undefined;
	let sessionHistory: PluginSessionHistory | undefined;
	let disposePromise: Promise<void> | undefined;
	const dispose = (): Promise<void> => {
		if (disposePromise !== undefined) {
			return disposePromise;
		}
		disposePromise = (async () => {
			try {
				await handle?.dispose();
			} finally {
				try {
					await sdk?.dispose();
				} finally {
					await fs.rm(root, { force: true, recursive: true });
				}
			}
		})();
		return disposePromise;
	};
	activeSessionFixtureCleanups.push(dispose);
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
		await fs.mkdir(workspace, { recursive: true });
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
		return { history, persistedEntry, readContext, sessionId };
	} catch (error) {
		await dispose();
		throw error;
	}
};

test("renderer registrations compose by priority and registration order", async () => {
	const registrationResults: PluginUIContributionResult[] = [];
	const firstPlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "first_renderer" });
		registrationResults.push(
			api.registerMessageRenderer(FirstMessageRenderer, { priority: 1 })
		);
		registrationResults.push(
			api.registerEntryRenderer(FirstEntryRenderer, { priority: 1 })
		);
	};
	const secondPlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "second_renderer" });
		registrationResults.push(
			api.registerMessageRenderer(SecondMessageRenderer, { priority: 8 })
		);
		registrationResults.push(
			api.registerEntryRenderer(SecondEntryRenderer, { priority: 8 })
		);
	};

	await withPluginRuntime(
		[
			{ factory: firstPlugin, id: "first_renderer" },
			{ factory: secondPlugin, id: "second_renderer" },
		],
		async (runtime) => {
			expect(registrationResults).toEqual([
				{ success: true },
				{ success: true },
				{ success: true },
				{ success: true },
			]);
			expect(runtime.getMessageRenderers()[0]?.pluginId).toBe(
				"second_renderer"
			);
			expect(runtime.getMessageRenderers()[1]?.pluginId).toBe("first_renderer");
			expect(runtime.getEntryRenderers()[0]?.pluginId).toBe("second_renderer");
			expect(runtime.getEntryRenderers()[1]?.pluginId).toBe("first_renderer");
			runtime.disablePlugin("second_renderer", "Resolver owner unloaded.");
			expect(
				runtime.getMessageRenderers().map(({ pluginId }) => pluginId)
			).toEqual(["first_renderer"]);
			expect(
				runtime.getEntryRenderers().map(({ pluginId }) => pluginId)
			).toEqual(["first_renderer"]);
		}
	);
});

test("Session-scoped Plugin failure removes its resolver only from that Session view", async () => {
	const failedSessionId = "renderer-session-disabled";
	const activeSessionId = "renderer-session-active";
	const plugin: PluginFactory = (api) => {
		const definition = api.definePlugin({ id: "session_message_renderer" });
		definition.onSessionStart(({ sessionId }) => {
			if (sessionId === failedSessionId) {
				throw new Error("Session-only renderer failure.");
			}
		});
		api.registerMessageRenderer((context) => {
			if (context.role !== "user") {
				return;
			}
			return <text>Session resolver override</text>;
		});
	};
	await withPluginRuntime(
		[{ factory: plugin, id: "session_message_renderer" }],
		async (runtime) => {
			await runtime.startSession({
				executionMode: "interactive",
				sessionId: failedSessionId,
				workspace: "/workspace",
			});
			await runtime.startSession({
				executionMode: "interactive",
				sessionId: activeSessionId,
				workspace: "/workspace",
			});
			setInteractiveRuntimeContext({
				args: [],
				cwd: "/workspace",
				pluginRuntime: runtime,
			});
			const failedMessage: SessionMessage = {
				id: sessionMessageId("renderer-session-disabled-message"),
				parts: [{ text: "Session-local host fallback", type: "text" }],
				role: "user",
			};
			const activeMessage: SessionMessage = {
				id: sessionMessageId("renderer-session-active-message"),
				parts: [{ text: "Session-local override target", type: "text" }],
				role: "user",
			};
			const setup = await testRender(
				<ThemeProvider themeName="opencode">
					<KeyboardLayerProvider>
						<ChatMessage
							messages={[failedMessage]}
							sessionId={failedSessionId}
						/>
						<ChatMessage
							messages={[activeMessage]}
							sessionId={activeSessionId}
						/>
					</KeyboardLayerProvider>
				</ThemeProvider>,
				{ height: 12, width: 64 }
			);
			try {
				await flushTestRenderer(setup, 2);
				const frame = captureTestFrame(setup) ?? "";
				expect(frame).toContain("Session-local host fallback");
				expect(frame).toContain("Session resolver override");
				expect(runtime.getMessageRenderers(failedSessionId)).toEqual([]);
				expect(runtime.getMessageRenderers(activeSessionId)).toHaveLength(1);
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

test("other Plugins override host messages by priority and unload only their resolvers", async () => {
	const resolverCalls: string[] = [];
	let resolverContext: PluginMessageRendererContext | undefined;
	const lowPriorityPlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "message_low_priority" });
		api.registerMessageRenderer(
			(_context) => {
				resolverCalls.push("low");
				return <text>lower-priority message</text>;
			},
			{ priority: 1 }
		);
	};
	const decliningPlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "message_declining" });
		api.registerMessageRenderer(
			(context) => {
				resolverCalls.push("decline");
				resolverContext = context;
				return;
			},
			{ priority: 10 }
		);
	};
	const winningPlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "message_winner" });
		api.registerMessageRenderer(
			(context) => {
				resolverCalls.push("winner");
				const textPart = context.message.parts.find(
					(part) => part.type === "text"
				);
				if (textPart !== undefined) {
					Reflect.set(textPart, "text", "mutation stays in the render copy");
				}
				return <text>higher-priority cross-Plugin message</text>;
			},
			{ priority: 10 }
		);
	};
	const laterTiePlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "message_later_tie" });
		api.registerMessageRenderer(
			(_context) => {
				resolverCalls.push("later-tie");
				return <text>later tied message</text>;
			},
			{ priority: 10 }
		);
	};
	const message: SessionMessage = {
		id: sessionMessageId("renderer-priority-host-message"),
		parts: [{ text: "unchanged host user message", type: "text" }],
		role: "user",
	};
	const modelInput = filterSessionMessagesForActiveContext([message]);
	await withPluginRuntime(
		[
			{ factory: lowPriorityPlugin, id: "message_low_priority" },
			{ factory: decliningPlugin, id: "message_declining" },
			{ factory: winningPlugin, id: "message_winner" },
			{ factory: laterTiePlugin, id: "message_later_tie" },
		],
		async (runtime) => {
			setInteractiveRuntimeContext({
				args: [],
				cwd: "/workspace",
				pluginRuntime: runtime,
			});
			const setup = await testRender(
				<ThemeProvider themeName="opencode">
					<KeyboardLayerProvider>
						<text>host-message-frame</text>
						<ChatMessage
							messages={[message]}
							sessionId="message-resolver-session"
						/>
					</KeyboardLayerProvider>
				</ThemeProvider>,
				{ height: 12, width: 64 }
			);
			try {
				await flushTestRenderer(setup, 2);
				let frame = captureTestFrame(setup) ?? "";
				expect(frame).toContain("higher-priority cross-Plugin message");
				expect(frame).not.toContain("later tied message");
				expect(frame).not.toContain("unchanged host user message");
				expect(resolverCalls).toEqual(["decline", "winner"]);
				expect(resolverContext?.role).toBe("user");
				expect(resolverContext?.originPluginId).toBeUndefined();
				expect(Object.isFrozen(resolverContext)).toBe(true);
				expect(message.parts[0]).toEqual({
					text: "unchanged host user message",
					type: "text",
				});
				expect(filterSessionMessagesForActiveContext([message])).toEqual(
					modelInput
				);

				await act(async () => {
					runtime.disablePlugin("message_winner", "Resolver owner unloaded.");
					await flushTestRenderer(setup, 2);
				});
				frame = captureTestFrame(setup) ?? "";
				expect(frame).toContain("later tied message");
				expect(frame).not.toContain("higher-priority cross-Plugin message");
				expect(
					runtime.getMessageRenderers().map(({ pluginId }) => pluginId)
				).toEqual([
					"message_declining",
					"message_later_tie",
					"message_low_priority",
				]);

				await act(async () => {
					runtime.disablePlugin(
						"message_later_tie",
						"Resolver owner unloaded."
					);
					await flushTestRenderer(setup, 2);
				});
				expect(captureTestFrame(setup)).toContain("lower-priority message");
				await act(async () => {
					runtime.disablePlugin(
						"message_low_priority",
						"Resolver owner unloaded."
					);
					await flushTestRenderer(setup, 2);
				});
				expect(captureTestFrame(setup)).toContain(
					"unchanged host user message"
				);
				expect(filterSessionMessagesForActiveContext([message])).toEqual(
					modelInput
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

test("next delegates through declining message resolvers and permits composition", async () => {
	let declined = 0;
	const wrapperPlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "message_wrapper" });
		api.registerMessageRenderer(
			(context, next) => {
				if (context.role !== "assistant") {
					return;
				}
				return (
					<box>
						<text>before delegated message</text>
						{next()}
						<text>after delegated message</text>
					</box>
				);
			},
			{ priority: 20 }
		);
	};
	const declinePlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "message_next_decline" });
		api.registerMessageRenderer(
			() => {
				declined += 1;
				return;
			},
			{ priority: 10 }
		);
	};
	const finalPlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "message_next_target" });
		api.registerMessageRenderer(
			(context) => {
				if (context.role !== "assistant") {
					return;
				}
				return <text>delegated message presentation</text>;
			},
			{ priority: 1 }
		);
	};
	const message: SessionMessage = {
		id: sessionMessageId("renderer-next-message"),
		parts: [{ text: "message that resolver replaces", type: "text" }],
		role: "assistant",
	};
	await withPluginRuntime(
		[
			{
				factory: pluginRendererCompositionExample,
				id: "renderer_composition_example",
			},
			{ factory: wrapperPlugin, id: "message_wrapper" },
			{ factory: declinePlugin, id: "message_next_decline" },
			{ factory: finalPlugin, id: "message_next_target" },
		],
		async (runtime) => {
			setInteractiveRuntimeContext({
				args: [],
				cwd: "/workspace",
				pluginRuntime: runtime,
			});
			const setup = await testRender(
				<ThemeProvider themeName="opencode">
					<KeyboardLayerProvider>
						<ChatMessage
							messages={[message]}
							sessionId="message-next-session"
						/>
					</KeyboardLayerProvider>
				</ThemeProvider>,
				{ height: 12, width: 64 }
			);
			try {
				await flushTestRenderer(setup, 2);
				const frame = captureTestFrame(setup) ?? "";
				expect(frame).toContain("Composed message starts");
				expect(frame).toContain("before delegated message");
				expect(frame).toContain("delegated message presentation");
				expect(frame).toContain("after delegated message");
				expect(frame).toContain("Composed message ends");
				expect(frame).not.toContain("message that resolver replaces");
				expect(declined).toBeGreaterThan(0);
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

test("null from a message resolver is an intentional empty render", async () => {
	let laterResolverCalls = 0;
	const emptyPlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "message_empty_renderer" });
		api.registerMessageRenderer(() => null, { priority: 10 });
	};
	const laterPlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "message_after_empty" });
		api.registerMessageRenderer(
			() => {
				laterResolverCalls += 1;
				return <text>later renderer should not run</text>;
			},
			{ priority: 1 }
		);
	};
	const message: SessionMessage = {
		id: sessionMessageId("renderer-null-message"),
		parts: [{ text: "intentionally empty host message", type: "text" }],
		role: "assistant",
	};
	await withPluginRuntime(
		[
			{ factory: emptyPlugin, id: "message_empty_renderer" },
			{ factory: laterPlugin, id: "message_after_empty" },
		],
		async (runtime) => {
			setInteractiveRuntimeContext({
				args: [],
				cwd: "/workspace",
				pluginRuntime: runtime,
			});
			const setup = await testRender(
				<ThemeProvider themeName="opencode">
					<KeyboardLayerProvider>
						<text>message-host-shell</text>
						<ChatMessage
							messages={[message]}
							sessionId="message-null-session"
						/>
					</KeyboardLayerProvider>
				</ThemeProvider>,
				{ height: 12, width: 64 }
			);
			try {
				await flushTestRenderer(setup, 2);
				const frame = captureTestFrame(setup) ?? "";
				expect(frame).toContain("message-host-shell");
				expect(frame).not.toContain("intentionally empty host message");
				expect(frame).not.toContain("later renderer should not run");
				expect(laterResolverCalls).toBe(0);
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

test("resolver and React-render failures continue to remaining messages and host fallback", async () => {
	const throwingPlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "message_throwing_resolver" });
		api.registerMessageRenderer(
			() => {
				throw new Error("Resolver callback failed.");
			},
			{ priority: 30 }
		);
	};
	function BrokenMessagePresentation(): never {
		throw new Error("React message component failed.");
	}
	const brokenComponentPlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "message_broken_component" });
		api.registerMessageRenderer(() => <BrokenMessagePresentation />, {
			priority: 20,
		});
	};
	const fallbackPlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "message_fallback_resolver" });
		api.registerMessageRenderer(
			(context) => {
				if (context.role !== "user") {
					return;
				}
				return <text>remaining message resolver fallback</text>;
			},
			{ priority: 10 }
		);
	};
	const message: SessionMessage = {
		id: sessionMessageId("renderer-failed-message"),
		parts: [{ text: "host user message after resolver failure", type: "text" }],
		role: "user",
	};
	await withPluginRuntime(
		[
			{ factory: throwingPlugin, id: "message_throwing_resolver" },
			{ factory: brokenComponentPlugin, id: "message_broken_component" },
			{ factory: fallbackPlugin, id: "message_fallback_resolver" },
		],
		async (runtime) => {
			setInteractiveRuntimeContext({
				args: [],
				cwd: "/workspace",
				pluginRuntime: runtime,
			});
			const setup = await testRender(
				<ThemeProvider themeName="opencode">
					<KeyboardLayerProvider>
						<ChatMessage
							messages={[message]}
							sessionId="message-failure-session"
						/>
					</KeyboardLayerProvider>
				</ThemeProvider>,
				{ height: 12, width: 64 }
			);
			try {
				await flushTestRenderer(setup, 3);
				expect(captureTestFrame(setup)).toContain(
					"remaining message resolver fallback"
				);
				await act(async () => {
					runtime.disablePlugin(
						"message_fallback_resolver",
						"Resolver owner unloaded."
					);
					await flushTestRenderer(setup, 3);
				});
				expect(captureTestFrame(setup)).toContain(
					"host user message after resolver failure"
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
			const renderers = runtime.getEntryRenderers();
			if (renderers.length !== 1) {
				throw new Error(
					"The history-entry example did not register its renderer."
				);
			}
			const context = Object.freeze({
				dimensions: Object.freeze({ height: 10, width: 48 }),
				entry,
				options: Object.freeze({ selectedPath: true }),
				originPluginId: "history_entry_renderer",
				theme: DEFAULT_THEME,
				type: entry.type,
			});
			const setup = await testRender(
				<ThemeProvider themeName={DEFAULT_THEME.name}>
					<PluginRendererResolution
						context={context}
						fallback={<text>host fallback</text>}
						resolvers={renderers}
						surface="entry"
						target="history_entry_renderer:note-added"
					/>
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
	function MessagePresentation({
		context,
	}: Readonly<{ context: PluginMessageRendererContext }>) {
		useEffect(() => {
			rendererLifecycle.mounted += 1;
			return () => {
				rendererLifecycle.unmounted += 1;
			};
		}, []);
		return (
			<text>{`presented:${context.role}:${context.theme.name}:${context.dimensions.width}:${context.options.streaming}`}</text>
		);
	}
	const renderer: PluginMessageRenderer = (context) => {
		presentedMessage = context.message;
		return <MessagePresentation context={context} />;
	};
	const plugin: PluginFactory = (api) => {
		api.definePlugin({ id: "transcript_renderer" });
		api.registerMessageRenderer(renderer);
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
					<KeyboardLayerProvider>
						<text>host-test-frame</text>
						<ChatMessage messages={[message]} sessionId="rendered-session" />
					</KeyboardLayerProvider>
				</ThemeProvider>,
				{ height: 12, width: 64 }
			);
			try {
				await flushTestRenderer(setup, 2);
				const frame = captureTestFrame(setup) ?? "";
				expect(frame).toContain("host-test-frame");
				expect(frame).toContain("presented:assistant:opencode:64:false");
				expect(frame).not.toContain("durable assistant text");
				expect(presentedMessage).toEqual(message);
				expect(presentedMessage).not.toBe(message);
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
		api.registerEntryRenderer(renderer, { priority: 1 });
	};
	let overrideContext: PluginEntryRendererContext | undefined;
	const crossPluginOverride: PluginFactory = (api) => {
		api.definePlugin({ id: "history_override" });
		api.registerEntryRenderer(
			(context, next) => {
				overrideContext = context;
				if (
					context.originPluginId !== "history_renderer" ||
					context.type !== "status"
				) {
					return;
				}
				return (
					<box>
						<text>other-Plugin history override</text>
						{next()}
					</box>
				);
			},
			{ priority: 8 }
		);
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
		[
			{ factory: plugin, id: "history_renderer" },
			{
				factory: pluginRendererCompositionExample,
				id: "renderer_composition_example",
			},
			{ factory: crossPluginOverride, id: "history_override" },
		],
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
				expect(setup.captureCharFrame()).toContain(
					"other-Plugin history override"
				);
				expect(setup.captureCharFrame()).toContain(
					"Composed entry from another Plugin"
				);
				expect(overrideContext?.originPluginId).toBe("history_renderer");
				expect(overrideContext?.type).toBe("status");
				expect(Object.isFrozen(overrideContext)).toBe(true);
				expect(renderedEntry).toEqual(persistedEntry);
				await act(async () => {
					runtime.disablePlugin("history_override", "Resolver owner unloaded.");
					await flushTestRenderer(setup, 3);
				});
				expect(setup.captureCharFrame()).toContain(
					"plugin-rendered:status:restored"
				);
				expect(setup.captureCharFrame()).not.toContain(
					"other-Plugin history override"
				);
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
