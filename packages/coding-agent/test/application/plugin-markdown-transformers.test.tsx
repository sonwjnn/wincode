import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MockTreeSitterClient } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type {
	PluginFactory,
	PluginMarkdownTransformerContext,
} from "@wincode/coding-agent";
import { logger, resolveLogFilePath } from "@wincode/utils";
import { act, useEffect, useState } from "react";
import { loadPlugins } from "@/modules/plugins/loader";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import type { SessionCompaction } from "@/modules/sessions/compaction";
import { resetInteractiveSessionHostManager } from "@/modules/sessions/host/session-host-manager";
import {
	filterSessionMessagesForActiveContext,
	type SessionMessage,
} from "@/modules/sessions/message";
import { ChatMessage } from "@/modules/sessions/ui/components/chat-message";
import { CompactionDivider } from "@/modules/sessions/ui/components/compaction-divider";
import { setTreeSitterClientOverride } from "@/modules/sessions/ui/tree-sitter-client";
import { createConfigStore } from "@/shared/config/config-store";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import {
	getInteractiveRuntimeContext,
	setInteractiveRuntimeContext,
} from "@/shared/runtime-context";
import { createInteractiveRuntimeLifecycle } from "@/shared/runtime-lifecycle";
import { reloadInteractiveResources } from "@/tui/commands/reload-resources";
import markdownTransformerExample from "../../examples/markdown-transformer-plugin";
import {
	compactionId,
	sessionId,
	sessionMessageId,
} from "../support/identifiers";
import { flushTestRenderer } from "../support/opentui";

const withPluginRuntime = async (
	factories: readonly Readonly<{ factory: PluginFactory; id: string }>[],
	action: (
		runtime: PluginRuntime,
		loadRuntime: (
			factories: readonly Readonly<{ factory: PluginFactory; id: string }>[]
		) => Promise<PluginRuntime>
	) => Promise<void>
): Promise<void> => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-markdown-api-"));
	const workspace = path.join(root, "workspace");
	await fs.mkdir(workspace, { recursive: true });
	const configStore = createConfigStore({
		homeRoot: root,
		trustedProjectRoots: [workspace],
	});
	const runtimes: PluginRuntime[] = [];
	const loadRuntime = async (
		runtimeFactories: readonly Readonly<{
			factory: PluginFactory;
			id: string;
		}>[]
	): Promise<PluginRuntime> => {
		const runtime = await loadPlugins({
			bundledPlugins: runtimeFactories,
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
		runtimes.push(runtime);
		return runtime;
	};
	try {
		await action(await loadRuntime(factories), loadRuntime);
	} finally {
		for (const runtime of runtimes) {
			await runtime.shutdown();
		}
		await fs.rm(root, { force: true, recursive: true });
	}
};

afterEach(() => {
	updateStatefulChat = undefined;
	setTreeSitterClientOverride(null);
	setInteractiveRuntimeContext({ args: [], cwd: "/workspace" });
});

const userMessage: SessionMessage = {
	id: sessionMessageId("markdown-transformer-user"),
	parts: [{ text: "original user text", type: "text" }],
	role: "user",
};

const assistantMessage: SessionMessage = {
	id: sessionMessageId("markdown-transformer-assistant"),
	parts: [
		{ text: "assistant thinking text", type: "reasoning" },
		{ text: "original assistant text", type: "text" },
	],
	role: "assistant",
};

const compactionSummary: SessionCompaction = {
	completedAt: new Date("2026-04-13T10:11:12.000Z"),
	createdAt: new Date("2026-04-13T10:10:11.000Z"),
	estimatedTokensAfter: 5,
	firstKeptUiMessageId: sessionMessageId("markdown-summary-first-kept"),
	id: compactionId("markdown-summary-entry"),
	sessionId: sessionId("markdown-summary-session"),
	sequence: 1,
	summarizationModel: DEFAULT_PROVIDER_MODEL_SELECTION,
	summary: {
		coveredMessageIds: [],
		formatVersion: 1,
		text: "## Archived summary",
	},
	tokensBefore: 10,
	throughMessageUiId: sessionMessageId("markdown-summary-through"),
	trigger: "manual",
};

let updateStatefulChat:
	| ((message: SessionMessage, streaming: boolean) => void)
	| undefined;

function StatefulChat({
	message,
	streaming,
}: {
	message: SessionMessage;
	streaming: boolean;
}) {
	const [view, setView] = useState({ message, streaming });
	useEffect(() => {
		updateStatefulChat = (nextMessage, nextStreaming) =>
			setView({ message: nextMessage, streaming: nextStreaming });
		return () => {
			updateStatefulChat = undefined;
		};
	}, []);
	return <ChatMessage messages={[view.message]} streaming={view.streaming} />;
}

test("Markdown transformer context reports measured width and reruns on terminal resize", async () => {
	const contexts: PluginMarkdownTransformerContext[] = [];
	const plugin: PluginFactory = (api) => {
		api.definePlugin({ id: "markdown_width_context" });
		api.registerMarkdownTransformer((markdown, context) => {
			contexts.push(context);
			return `${markdown}|width-${context.availableWidth}`;
		});
	};
	setTreeSitterClientOverride(
		new MockTreeSitterClient({ autoResolveTimeout: 0 })
	);
	await withPluginRuntime(
		[{ factory: plugin, id: "markdown_width_context" }],
		async (runtime) => {
			setInteractiveRuntimeContext({
				args: [],
				cwd: "/workspace",
				pluginRuntime: runtime,
			});
			const setup = await testRender(
				<ThemeProvider themeName="opencode">
					<KeyboardLayerProvider>
						<StatefulChat message={userMessage} streaming={false} />
					</KeyboardLayerProvider>
				</ThemeProvider>,
				{ height: 12, width: 64 }
			);
			try {
				await flushTestRenderer(setup, 3);
				expect(setup.captureCharFrame()).toContain(
					"original user text|width-60"
				);
				expect(contexts.at(-1)).toEqual({
					availableWidth: 60,
					isStreaming: false,
					messageId: userMessage.id,
					messageType: "user",
					timestamp: undefined,
				});

				await act(async () => {
					setup.resize(80, 12);
				});
				await flushTestRenderer(setup, 3);
				expect(setup.captureCharFrame()).toContain(
					"original user text|width-76"
				);
				expect(contexts.at(-1)?.availableWidth).toBe(76);
				expect(contexts.at(-1)?.messageId).toBe(userMessage.id);
			} finally {
				await setup.dispose();
			}
		}
	);
});

test("stream updates transform fresh source and restored assistant messages expose their persisted identity", async () => {
	const calls: Readonly<{
		markdown: string;
		context: PluginMarkdownTransformerContext;
	}>[] = [];
	const plugin: PluginFactory = (api) => {
		api.definePlugin({ id: "markdown_stream_context" });
		api.registerMarkdownTransformer((markdown, context) => {
			calls.push({ context, markdown });
			return `${markdown}|${context.isStreaming ? "streaming" : "restored"}`;
		});
	};
	setTreeSitterClientOverride(
		new MockTreeSitterClient({ autoResolveTimeout: 0 })
	);
	await withPluginRuntime(
		[{ factory: plugin, id: "markdown_stream_context" }],
		async (runtime) => {
			setInteractiveRuntimeContext({
				args: [],
				cwd: "/workspace",
				pluginRuntime: runtime,
			});
			const liveMessage: SessionMessage = {
				id: sessionMessageId("markdown-streaming-assistant"),
				parts: [{ text: "partial answer", type: "text" }],
				role: "assistant",
			};
			const setup = await testRender(
				<ThemeProvider themeName="opencode">
					<KeyboardLayerProvider>
						<StatefulChat message={liveMessage} streaming />
					</KeyboardLayerProvider>
				</ThemeProvider>,
				{ height: 12, width: 64 }
			);
			try {
				await flushTestRenderer(setup, 3);
				expect(setup.captureCharFrame()).toContain("partial answer|streaming");
				expect(calls.at(-1)?.context).toMatchObject({
					isStreaming: true,
					messageId: undefined,
					messageType: "assistant",
				});

				const completedMessage: SessionMessage = {
					...liveMessage,
					parts: [{ text: "final answer", type: "text" }],
				};
				await act(async () => {
					updateStatefulChat?.(completedMessage, false);
				});
				await flushTestRenderer(setup, 3);
				expect(setup.captureCharFrame()).toContain("final answer|restored");
				expect(calls.at(-1)).toMatchObject({
					markdown: "final answer",
					context: {
						isStreaming: false,
						messageId: completedMessage.id,
						messageType: "assistant",
					},
				});
				expect(calls.map(({ markdown }) => markdown)).not.toContain(
					"partial answer|streaming"
				);
			} finally {
				await setup.dispose();
			}

			const restoredMessage: SessionMessage = {
				...liveMessage,
				parts: [{ text: "restored answer", type: "text" }],
			};
			const restoredSetup = await testRender(
				<ThemeProvider themeName="opencode">
					<KeyboardLayerProvider>
						<ChatMessage messages={[restoredMessage]} />
					</KeyboardLayerProvider>
				</ThemeProvider>,
				{ height: 12, width: 64 }
			);
			try {
				await flushTestRenderer(restoredSetup, 3);
				expect(restoredSetup.captureCharFrame()).toContain("restored answer");
				expect(restoredSetup.captureCharFrame()).toContain("|restored");
				expect(calls.at(-1)).toMatchObject({
					markdown: "restored answer",
					context: {
						isStreaming: false,
						messageId: restoredMessage.id,
						messageType: "assistant",
					},
				});
			} finally {
				await restoredSetup.dispose();
			}
		}
	);
});

test("the authoring example transforms displayed Markdown without rewriting its message", async () => {
	const message: SessionMessage = {
		id: sessionMessageId("markdown-transformer-example"),
		parts: [{ text: "Before --> after", type: "text" }],
		role: "user",
	};
	setTreeSitterClientOverride(
		new MockTreeSitterClient({ autoResolveTimeout: 0 })
	);
	await withPluginRuntime(
		[
			{
				factory: markdownTransformerExample,
				id: "markdown_transformer_example",
			},
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
						<ChatMessage messages={[message]} />
					</KeyboardLayerProvider>
				</ThemeProvider>,
				{ height: 12, width: 64 }
			);
			try {
				await flushTestRenderer(setup, 3);
				expect(setup.captureCharFrame()).toContain("Before → after");
				expect(message.parts[0]).toEqual({
					text: "Before --> after",
					type: "text",
				});
			} finally {
				await setup.dispose();
			}
		}
	);
});

test("a failed Markdown transformer preserves prior output, continues, and never mutates model messages", async () => {
	const throwInputs: string[] = [];
	const continuationInputs: string[] = [];
	const successfulPlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "markdown_successful" });
		api.registerMarkdownTransformer((markdown) => `${markdown}|successful`);
	};
	const failingPlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "markdown_failing" });
		api.registerMarkdownTransformer((markdown) => {
			throwInputs.push(markdown);
			throw new Error("Expected display-transform failure.");
		});
	};
	const continuingPlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "markdown_continuing" });
		api.registerMarkdownTransformer((markdown) => {
			continuationInputs.push(markdown);
			return `${markdown}|continued`;
		});
	};
	const message: SessionMessage = {
		id: sessionMessageId("markdown-failure-user"),
		parts: [{ text: "unchanged source text", type: "text" }],
		role: "user",
	};
	const originalMessage = structuredClone(message);
	const modelContext = filterSessionMessagesForActiveContext([message]);
	const previousHome = process.env.HOME;
	const logHome = await fs.mkdtemp(
		path.join(os.tmpdir(), "markdown-transform-log-")
	);
	process.env.HOME = logHome;
	try {
		setTreeSitterClientOverride(
			new MockTreeSitterClient({ autoResolveTimeout: 0 })
		);
		await withPluginRuntime(
			[
				{ factory: successfulPlugin, id: "markdown_successful" },
				{ factory: failingPlugin, id: "markdown_failing" },
				{ factory: continuingPlugin, id: "markdown_continuing" },
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
							<ChatMessage messages={[message]} />
						</KeyboardLayerProvider>
					</ThemeProvider>,
					{ height: 12, width: 64 }
				);
				try {
					await flushTestRenderer(setup, 3);
					expect(setup.captureCharFrame()).toContain(
						"unchanged source text|successful|continued"
					);
					expect(throwInputs.at(-1)).toBe("unchanged source text|successful");
					expect(continuationInputs.at(-1)).toBe(
						"unchanged source text|successful"
					);
					expect(message).toEqual(originalMessage);
					expect(filterSessionMessagesForActiveContext([message])).toEqual(
						modelContext
					);

					await act(async () => {
						runtime.disablePlugin("markdown_successful", "Plugin unloaded.");
						await flushTestRenderer(setup, 3);
					});
					expect(setup.captureCharFrame()).toContain(
						"unchanged source text|continued"
					);
					expect(message).toEqual(originalMessage);
					expect(filterSessionMessagesForActiveContext([message])).toEqual(
						modelContext
					);
				} finally {
					await setup.dispose();
				}
			}
		);
		await logger.flush();
		const diagnostics = await fs.readFile(resolveLogFilePath(), "utf8");
		expect(diagnostics).toContain(
			'"message":"Plugin Markdown transformer failed; preserving the last successful output"'
		);
		expect(diagnostics).toContain('"operation":"plugin.ui.markdown.transform"');
		expect(diagnostics).toContain('"pluginId":"markdown_failing"');
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		await fs.rm(logHome, { force: true, recursive: true });
	}
});

test("the opt-in summary surface transforms expanded persisted compaction text with entry context", async () => {
	const contexts: PluginMarkdownTransformerContext[] = [];
	const plugin: PluginFactory = (api) => {
		api.definePlugin({ id: "markdown_summary_surface" });
		api.registerMarkdownTransformer(
			(markdown, context) => {
				contexts.push(context);
				return markdown.replace("Archived", "Transformed");
			},
			{ messageTypes: ["summary"] }
		);
	};
	setTreeSitterClientOverride(
		new MockTreeSitterClient({ autoResolveTimeout: 0 })
	);
	await withPluginRuntime(
		[{ factory: plugin, id: "markdown_summary_surface" }],
		async (runtime) => {
			setInteractiveRuntimeContext({
				args: [],
				cwd: "/workspace",
				pluginRuntime: runtime,
			});
			const setup = await testRender(
				<ThemeProvider themeName="opencode">
					<KeyboardLayerProvider>
						<CompactionDivider entry={compactionSummary} />
					</KeyboardLayerProvider>
				</ThemeProvider>,
				{ height: 12, width: 64 }
			);
			try {
				await flushTestRenderer(setup, 3);
				expect(contexts).toEqual([]);
				const divider = setup.renderer.root.findDescendantById(
					`compaction-divider-${compactionSummary.id}`
				);
				if (divider === undefined) {
					throw new Error("Compaction divider was not rendered.");
				}
				await act(async () => {
					divider.focus();
					setup.mockInput.pressEnter();
				});
				await flushTestRenderer(setup, 3);
				expect(setup.captureCharFrame()).toContain("Transformed summary");
				expect(contexts.at(-1)).toMatchObject({
					availableWidth: 62,
					isStreaming: false,
					messageId: compactionSummary.id,
					messageType: "summary",
					timestamp: compactionSummary.createdAt.toISOString(),
				});
				expect(compactionSummary.summary.text).toBe("## Archived summary");
			} finally {
				await setup.dispose();
			}
		}
	);
});

test("a later Markdown registration replaces its Plugin transformer and keeps Plugin order", async () => {
	const calls: string[] = [];
	const summarySurfaceCalls: string[] = [];
	const firstPlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "markdown_first" });
		api.registerMarkdownTransformer((markdown, { messageType }) => {
			calls.push(`first:${messageType}:${markdown}`);
			return `${markdown}|first`;
		});
		api.registerMarkdownTransformer((markdown, { messageType }) => {
			calls.push(`replacement:${messageType}:${markdown}`);
			return `${markdown}|replacement`;
		});
	};
	const assistantOnlyPlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "markdown_assistant_only" });
		api.registerMarkdownTransformer(
			(markdown, { messageType }) => {
				calls.push(`assistant-only:${messageType}:${markdown}`);
				return `${markdown}|assistant-only`;
			},
			{ messageTypes: ["assistant"] }
		);
	};
	const summarySurfacePlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "markdown_summary_only" });
		api.registerMarkdownTransformer(
			(markdown, { messageType }) => {
				summarySurfaceCalls.push(messageType);
				return `${markdown}|summary-only`;
			},
			{ messageTypes: ["summary"] }
		);
	};

	setTreeSitterClientOverride(
		new MockTreeSitterClient({ autoResolveTimeout: 0 })
	);
	await withPluginRuntime(
		[
			{ factory: firstPlugin, id: "markdown_first" },
			{ factory: assistantOnlyPlugin, id: "markdown_assistant_only" },
			{
				factory: summarySurfacePlugin,
				id: "markdown_summary_only",
			},
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
						<ChatMessage messages={[userMessage, assistantMessage]} streaming />
					</KeyboardLayerProvider>
				</ThemeProvider>,
				{ height: 16, width: 64 }
			);
			try {
				await flushTestRenderer(setup, 3);
				const frame = setup.captureCharFrame();
				expect(frame).toContain("original user text|replacement");
				expect(frame).toContain(
					"original assistant text|replacement|assistant-only"
				);
				expect(frame).toContain("assistant thinking text|replacement");
				expect(calls).not.toContain("first:user:original user text");
				expect(calls).toContain(
					"replacement:assistant:original assistant text"
				);
				expect(calls).toContain(
					"assistant-only:assistant:original assistant text|replacement"
				);
				expect(calls).not.toContain(
					"assistant-only:user:original user text|replacement"
				);
				expect(calls).not.toContain(
					"assistant-only:assistant-thinking:assistant thinking text|replacement"
				);
				expect(summarySurfaceCalls).toEqual([]);
			} finally {
				await setup.dispose();
			}
		}
	);
});

test("Interactive reload shuts down old Markdown transforms and preserves other Plugin order", async () => {
	const calls: string[] = [];
	const oldTransformer: PluginFactory = (api) => {
		api.definePlugin({ id: "markdown_reload_target" });
		api.registerMarkdownTransformer((markdown) => {
			calls.push(`old:${markdown}`);
			return `${markdown}|old`;
		});
	};
	const replacementTransformer: PluginFactory = (api) => {
		api.definePlugin({ id: "markdown_reload_target" });
		api.registerMarkdownTransformer((markdown) => {
			calls.push(`replacement:${markdown}`);
			return `${markdown}|replacement`;
		});
	};
	const otherTransformer: PluginFactory = (api) => {
		api.definePlugin({ id: "markdown_reload_other" });
		api.registerMarkdownTransformer((markdown) => {
			calls.push(`other:${markdown}`);
			return `${markdown}|other`;
		});
	};
	const context: PluginMarkdownTransformerContext = {
		availableWidth: 60,
		isStreaming: false,
		messageId: undefined,
		messageType: "user",
		timestamp: undefined,
	};

	try {
		await withPluginRuntime(
			[
				{ factory: oldTransformer, id: "markdown_reload_target" },
				{ factory: otherTransformer, id: "markdown_reload_other" },
			],
			async (oldRuntime, loadRuntime) => {
				const replacementRuntime = await loadRuntime([
					{ factory: replacementTransformer, id: "markdown_reload_target" },
					{ factory: otherTransformer, id: "markdown_reload_other" },
				]);
				const configRuntime = {
					configStore: createConfigStore({
						homeRoot: "/workspace",
						trustedProjectRoots: [],
					}),
					cwd: "/workspace",
					homeRoot: "/workspace",
					workspace: "/workspace",
				};
				setInteractiveRuntimeContext({
					args: [],
					configRuntime,
					cwd: "/workspace",
					pluginRuntime: oldRuntime,
					resourceLoader: {
						reload: async ({ current }) => ({
							configRuntime: current.configRuntime,
							diagnostics: [],
							pluginRuntime: replacementRuntime,
							pluginRuntimeChanged: true,
						}),
					},
				});
				expect(oldRuntime.transformMarkdown("message", context)).toBe(
					"message|old|other"
				);
				expect(calls).toEqual(["old:message", "other:message|old"]);

				await reloadInteractiveResources({
					lifecycle: createInteractiveRuntimeLifecycle(),
					refreshAgentRegistry: () => undefined,
					reloadTheme: () => undefined,
					toast: { show: () => undefined },
				});

				expect(getInteractiveRuntimeContext().pluginRuntime).toBe(
					replacementRuntime
				);
				expect(oldRuntime.transformMarkdown("stale message", context)).toBe(
					"stale message"
				);
				expect(replacementRuntime.transformMarkdown("message", context)).toBe(
					"message|replacement|other"
				);
				expect(calls).toEqual([
					"old:message",
					"other:message|old",
					"replacement:message",
					"other:message|replacement",
				]);
			}
		);
	} finally {
		await resetInteractiveSessionHostManager();
	}
});
