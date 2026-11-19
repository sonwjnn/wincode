import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import {
	agentIdSchema,
	createAgentRuntime,
	createStatefulAgent,
} from "@wincode/agent-core";
import type { ProviderChatEvent } from "@wincode/ai";
import type { PluginFactory } from "@wincode/coding-agent";
import { testRender } from "@wincode/tui/testing";
import { act, useState } from "react";
import { loadPlugins } from "@/modules/plugins/loader";
import { createPluginTools } from "@/modules/plugins/tools";
import type { SessionCacheWarming } from "@/modules/prompt-cache/cache-warming";
import { projectAgentTurnEvent } from "@/modules/sessions/agent-session/turn";
import type {
	SessionQueuedSubmission,
	SessionSkillCatalog,
} from "@/modules/sessions/agent-session/types";
import { createAgentSessionTurnRunner } from "@/modules/sessions/host/agent-session-turn-runner";
import type { SessionMessage } from "@/modules/sessions/message";
import type { SessionLifecycle } from "@/modules/sessions/storage/session-lifecycle";
import type { SessionRecords } from "@/modules/sessions/storage/session-records";
import { BotMessageContent } from "@/modules/sessions/ui/messages/bot-message";
import { createConfigStore } from "@/shared/config/config-store";
import { toSessionId } from "@/shared/identifiers";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import pluginRendererCompositionExample from "../../examples/plugin-renderer-composition";
import pluginToolRendererExample from "../../examples/plugin-tool-renderer";
import pluginToolRendererFixture, {
	pluginToolRendererFixtureState,
	resetPluginToolRendererFixtureState,
} from "../fixtures/plugin-tool-renderer-fixture";
import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
} from "../support/e2e-fake-runtime";
import {
	agentTurnId,
	modelId,
	sessionMessageId,
	toolCallId,
} from "../support/identifiers";
import { flushTestRenderer } from "../support/opentui";

type DynamicToolPart = Extract<
	SessionMessage["parts"][number],
	{ type: "dynamic-tool" }
>;

const leadingSpacesFor = (frame: string, marker: string): number => {
	const line = frame
		.split("\n")
		.find((candidate) => candidate.includes(marker));
	if (line === undefined) {
		throw new Error(`The terminal frame did not contain '${marker}'.`);
	}
	return line.length - line.trimStart().length;
};

const createRendererEnvironment = async (
	pluginFactory: PluginFactory = pluginToolRendererFixture,
	pluginId = "tool_renderer_fixture",
	additionalPlugins: readonly Readonly<{
		factory: PluginFactory;
		id: string;
	}>[] = []
) => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-plugin-tool-renderer-")
	);
	const workspace = path.join(root, "workspace");
	await fs.mkdir(workspace, { recursive: true });
	const sessionId = toSessionId("plugin-tool-renderer-session");
	const runtime = await loadPlugins({
		bundledPlugins: [
			{ factory: pluginFactory, id: pluginId },
			...additionalPlugins,
		],
		cliPaths: [],
		config: {
			configStore: createConfigStore({ homeRoot: root }),
			cwd: workspace,
			homeRoot: root,
			workspace,
		},
		userDataDir: root,
	});
	await runtime.startSession({
		executionMode: "interactive",
		sessionId,
		workspace,
	});
	const toolName = runtime
		.getToolDescriptors(sessionId)
		.find((tool) => tool.localName === "lookup")?.name;
	if (toolName === undefined) {
		await runtime.shutdown();
		await fs.rm(root, { force: true, recursive: true });
		throw new Error("The fixture Plugin Tool was not registered.");
	}
	let setRenderedParts: ((parts: SessionMessage["parts"]) => void) | undefined;
	const runningPart: DynamicToolPart = {
		input: { query: "WCO-288" },
		state: "input-available",
		toolCallId: toolCallId("plugin-tool-renderer-call"),
		toolName,
		type: "dynamic-tool",
	};
	function FixtureTranscript() {
		const [parts, setParts] = useState<SessionMessage["parts"]>([runningPart]);
		setRenderedParts = setParts;
		return (
			<BotMessageContent
				parts={parts}
				pluginRuntime={runtime}
				sessionId={sessionId}
			/>
		);
	}
	const setup = await testRender(
		<ThemeProvider themeName="opencode">
			<KeyboardLayerProvider>
				<FixtureTranscript />
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ exitOnCtrlC: false, height: 12, width: 80 }
	);
	await flushTestRenderer(setup, 2);
	const updateParts = (parts: SessionMessage["parts"]): void => {
		if (setRenderedParts === undefined) {
			throw new Error("The fixture transcript has not rendered.");
		}
		setRenderedParts(parts);
	};
	let sessionStopped = false;
	const stopSession = async (): Promise<void> => {
		if (sessionStopped) {
			return;
		}
		sessionStopped = true;
		await runtime.stopSession({
			executionMode: "interactive",
			sessionId,
			workspace,
		});
	};
	let disposed = false;
	const dispose = async (): Promise<void> => {
		if (disposed) {
			return;
		}
		disposed = true;
		await act(async () => {
			setup.renderer.destroy();
			await setup.renderer.closed;
		});
		await stopSession();
		await runtime.shutdown();
		await fs.rm(root, { force: true, recursive: true });
	};
	return {
		dispose,
		stopSession,
		runtime,
		updateParts,
		sessionId,
		setup,
		toolName,
		workspace,
	};
};

test("Plugin Tool renderers receive live call and result updates through the host theme and expansion key", async () => {
	resetPluginToolRendererFixtureState();
	const environment = await createRendererEnvironment();
	try {
		const tool = createPluginTools({
			agentId: agentIdSchema.parse("build"),
			pluginRuntime: environment.runtime,
			pluginTools: environment.runtime.getToolDescriptors(
				environment.sessionId
			),
			sessionId: environment.sessionId,
			workspace: environment.workspace,
		}).find(({ definition }) => definition.name === environment.toolName);
		if (tool === undefined) {
			throw new Error("The fixture Plugin Tool was not executable.");
		}

		expect(environment.setup.captureCharFrame()).toContain(
			"fixture call input-available"
		);
		expect(pluginToolRendererFixtureState.callStates).toContain(
			"input-available"
		);
		const streamingPart: DynamicToolPart = {
			input: { mutateCall: true, query: "WCO-288" },
			state: "input-streaming",
			toolCallId: toolCallId("plugin-tool-renderer-call"),
			toolName: environment.toolName,
			type: "dynamic-tool",
		};
		await act(() => environment.updateParts([streamingPart]));
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain(
			"fixture call input-streaming"
		);
		expect(pluginToolRendererFixtureState.callStates).toContain(
			"input-streaming"
		);
		expect(streamingPart.input).toEqual({
			mutateCall: true,
			query: "WCO-288",
		});
		expect(pluginToolRendererFixtureState.executionCount).toBe(0);
		const outcome = await tool.execute({
			input: { query: "WCO-288" },
			toolCallId: toolCallId("plugin-tool-renderer-call"),
		});
		if (outcome.type !== "success") {
			throw new Error(`The fixture Tool failed: ${outcome.errorText}`);
		}
		const part: DynamicToolPart = {
			input: { query: "WCO-288" },
			state: "output-available",
			output: outcome.output,
			toolCallId: toolCallId("plugin-tool-renderer-call"),
			toolName: environment.toolName,
			type: "dynamic-tool",
		};
		const storedOutput = structuredClone(part.output);
		expect(pluginToolRendererFixtureState.executionCount).toBe(1);
		await act(() => environment.updateParts([part]));
		await flushTestRenderer(environment.setup, 2);

		const frame = environment.setup.captureCharFrame();
		expect(frame).toContain("fixture call output-available");
		expect(frame).toContain("fixture result result for WCO-288 collapsed");
		expect(frame).toContain("opencode");
		expect(frame).toContain("80x12");
		expect(pluginToolRendererFixtureState.resultMounts).toBe(1);
		expect(pluginToolRendererFixtureState.executionCount).toBe(1);

		await act(() => environment.setup.mockInput.pressKey("o", { ctrl: true }));
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain(
			"fixture result result for WCO-288 expanded"
		);
		expect(pluginToolRendererFixtureState.resultStates).toContain(true);
		expect(part.output).toEqual(storedOutput);
		await environment.dispose();
		expect(pluginToolRendererFixtureState.callUnmounts).toBe(1);
		expect(pluginToolRendererFixtureState.resultUnmounts).toBe(1);
	} finally {
		await environment.dispose();
	}
});

test("public Tool resolvers override host and other-Plugin rows without changing execution", async () => {
	resetPluginToolRendererFixtureState();
	const observedTargets: Readonly<{
		originPluginId: string | undefined;
		type: string;
	}>[] = [];
	const overridePlugin: PluginFactory = (api) => {
		api.definePlugin({ id: "cross_tool_renderer" });
		api.registerToolRenderer(
			(context, next) => {
				observedTargets.push({
					originPluginId: context.originPluginId,
					type: context.type,
				});
				if (
					context.originPluginId === "tool_renderer_fixture" &&
					context.call.toolName.endsWith("_lookup")
				) {
					return (
						<box>
							<text>{`other-Plugin Tool ${context.call.state}`}</text>
							{next()}
						</box>
					);
				}
				if (
					context.originPluginId === undefined &&
					context.type === "tool-shell"
				) {
					return <text>host Tool override</text>;
				}
				return;
			},
			{ priority: 5 }
		);
	};
	const environment = await createRendererEnvironment(
		pluginToolRendererFixture,
		"tool_renderer_fixture",
		[
			{
				factory: pluginRendererCompositionExample,
				id: "renderer_composition_example",
			},
			{ factory: overridePlugin, id: "cross_tool_renderer" },
		]
	);
	try {
		const tool = createPluginTools({
			agentId: agentIdSchema.parse("build"),
			pluginRuntime: environment.runtime,
			pluginTools: environment.runtime.getToolDescriptors(
				environment.sessionId
			),
			sessionId: environment.sessionId,
			workspace: environment.workspace,
		}).find(({ definition }) => definition.name === environment.toolName);
		if (tool === undefined) {
			throw new Error("The fixture Plugin Tool was not executable.");
		}
		const input = { query: "WCO-290" };
		const outcome = await tool.execute({
			input,
			toolCallId: toolCallId("plugin-tool-renderer-override"),
		});
		if (outcome.type !== "success") {
			throw new Error(`The fixture Tool failed: ${outcome.errorText}`);
		}
		const resultPart: DynamicToolPart = {
			input,
			output: outcome.output,
			state: "output-available",
			toolCallId: toolCallId("plugin-tool-renderer-override"),
			toolName: environment.toolName,
			type: "dynamic-tool",
		};
		const storedInput = structuredClone(resultPart.input);
		const storedOutput = structuredClone(resultPart.output);
		const hostPart: SessionMessage["parts"][number] = {
			input: { command: "true" },
			state: "input-available",
			toolCallId: toolCallId("host-tool-renderer-override"),
			type: "tool-shell",
		};
		await act(() => environment.updateParts([resultPart, hostPart]));
		await flushTestRenderer(environment.setup, 2);
		const frame = environment.setup.captureCharFrame();
		expect(frame).toContain("Composed Tool output-available");
		expect(frame).toContain("other-Plugin Tool output-available");
		expect(frame).toContain("fixture result result for WCO-290 collapsed");
		expect(frame).toContain("host Tool override");
		expect(observedTargets).toContainEqual({
			originPluginId: "tool_renderer_fixture",
			type: "dynamic-tool",
		});
		expect(observedTargets).toContainEqual({
			originPluginId: undefined,
			type: "tool-shell",
		});
		expect(resultPart.input).toEqual(storedInput);
		expect(resultPart.output).toEqual(storedOutput);
		expect(pluginToolRendererFixtureState.executionCount).toBe(1);
		expect(outcome.output).toMatchObject({ answer: "result for WCO-290" });
	} finally {
		await environment.dispose();
	}
});

test("Plugin Tool renderers use the host shell by default and own it when opted in", async () => {
	const environment = await createRendererEnvironment();
	try {
		const descriptors = environment.runtime.getToolDescriptors(
			environment.sessionId
		);
		const ownedShellTool = descriptors.find(
			(tool) => tool.localName === "owned_shell"
		);
		if (ownedShellTool === undefined) {
			throw new Error("The owned-shell Plugin Tool was not registered.");
		}
		expect(ownedShellTool.ownsRowShell).toBe(true);
		const defaultShellFrame = environment.setup.captureCharFrame();
		const defaultShellPadding = leadingSpacesFor(
			defaultShellFrame,
			"fixture call input-available"
		);

		await act(() =>
			environment.updateParts([
				{
					input: { query: "WCO-288" },
					state: "input-available",
					toolCallId: toolCallId("plugin-owned-shell-call"),
					toolName: ownedShellTool.name,
					type: "dynamic-tool",
				},
			])
		);
		await flushTestRenderer(environment.setup, 2);

		const ownedShellFrame = environment.setup.captureCharFrame();
		expect(ownedShellFrame).toContain("owned call input-available");
		expect(
			leadingSpacesFor(ownedShellFrame, "owned call input-available")
		).toBeGreaterThan(defaultShellPadding);
	} finally {
		await environment.dispose();
	}
});

test("Session-scoped Plugin Tool renderers follow the owning Session lifecycle", async () => {
	const environment = await createRendererEnvironment();
	try {
		const descriptor = environment.runtime
			.getToolDescriptors(environment.sessionId)
			.find((tool) => tool.localName === "session_scoped");
		if (descriptor?.renderCall === undefined) {
			throw new Error("The Session-scoped Plugin Tool was not registered.");
		}
		const part: DynamicToolPart = {
			input: { query: "WCO-288" },
			state: "input-available",
			toolCallId: toolCallId("plugin-session-scoped-renderer-call"),
			toolName: descriptor.name,
			type: "dynamic-tool",
		};
		await act(() => environment.updateParts([part]));
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain(
			"session-scoped call input-available"
		);

		await environment.stopSession();
		await act(() => environment.updateParts([part]));
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain(
			"plugin_tool_renderer_fixture_session_scoped"
		);
		expect(environment.setup.captureCharFrame()).not.toContain(
			"session-scoped call"
		);
	} finally {
		await environment.dispose();
	}
});

test("turn-scoped Plugin Tool renderer metadata expires in the real turn runner finalizer", async () => {
	resetPluginToolRendererFixtureState();
	const environment = await createRendererEnvironment();
	const recorder = createFakeProviderRecorder();
	const providerCollection = createFakeProviderCollection(recorder);
	const selectedModel = {
		modelId: modelId("gpt-5.6-luna"),
		providerId: "openai",
	};
	const agentId = agentIdSchema.parse("build");
	const sourceMessageId = sessionMessageId("plugin-turn-renderer-user");
	const execution = {
		agent: agentId,
		assistantId: sessionMessageId("plugin-turn-renderer-assistant"),
		model: selectedModel,
		sessionModel: selectedModel,
		sourceUserMessageId: sourceMessageId,
		startedAt: 1,
		turnId: agentTurnId("plugin-turn-renderer-turn"),
	};
	const statefulAgent = createStatefulAgent<SessionQueuedSubmission>({
		runtime: createAgentRuntime({ providerCollection }),
	});
	let modelSteps = 0;
	let turnToolName: string | undefined;
	recorder.stepScript = async function* (
		request
	): AsyncGenerator<ProviderChatEvent> {
		modelSteps += 1;
		if (modelSteps === 1) {
			const turnTool = request.tools?.find(({ name }) =>
				name.includes("turn_scoped")
			);
			if (turnTool === undefined) {
				throw new Error(
					"The deterministic model did not receive the turn Tool."
				);
			}
			turnToolName = turnTool.name;
			yield {
				input: { query: "WCO-288" },
				toolCallId: "plugin-turn-renderer-call",
				toolName: turnTool.name,
				type: "tool-call",
			};
		} else {
			yield { delta: "Turn complete", type: "text-delta" };
		}
		yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
		yield { completion: { kind: "completed" }, type: "finish" };
	};
	try {
		await providerCollection.setCredential("openai", "fixture-credential");
		await act(() => environment.updateParts([]));
		await flushTestRenderer(environment.setup, 2);
		const configStore = createConfigStore({
			homeRoot: environment.workspace,
		});
		const configRuntime = {
			configStore,
			cwd: environment.workspace,
			homeRoot: environment.workspace,
			workspace: environment.workspace,
		};
		const runner = createAgentSessionTurnRunner({
			cacheWarming: fromPartial<SessionCacheWarming>({}),
			capabilities: {
				getCapabilityCeiling: () => undefined,
				getConfig: () => configRuntime,
				getPluginRuntime: () => environment.runtime,
				getRegistry: () => null,
			},
			editMode: fromPartial<Pick<SessionLifecycle, "getEditMode">>({}),
			providerCollection,
			records: fromPartial<SessionRecords>({}),
			sessionId: environment.sessionId,
			statefulAgent,
		});
		let projectedMessages: SessionMessage[] = [];
		let callRenderedDuringTurn = false;
		let resultRenderedDuringTurn = false;
		const ignoreAsync = async (): Promise<void> => undefined;
		const ignore = (): void => undefined;
		const outcome = await runner.run({
			armedSkill: fromPartial<SessionSkillCatalog>({
				agentId,
				diagnostic: null,
			}),
			callbacks: {
				commitStep: ignoreAsync,
				commitTerminal: ignoreAsync,
				commitToolCall: ignoreAsync,
				onEvent: async (event) => {
					const projected = projectAgentTurnEvent(
						projectedMessages,
						execution,
						event
					);
					if (projected === undefined) {
						return;
					}
					projectedMessages = projected.messages;
					if (
						event.type !== "tool-call-started" &&
						event.type !== "tool-call-finished"
					) {
						return;
					}
					const toolPart = projected.message.parts.find(
						(part): part is DynamicToolPart => part.type === "dynamic-tool"
					);
					if (toolPart === undefined) {
						throw new Error(
							"The real turn did not project its Plugin Tool Call."
						);
					}
					await act(() => environment.updateParts([toolPart]));
					await flushTestRenderer(environment.setup, 2);
					const frame = environment.setup.captureCharFrame();
					if (event.type === "tool-call-started") {
						expect(frame).toContain("turn-scoped call input-available");
						callRenderedDuringTurn = true;
					} else {
						expect(frame).toContain("turn-scoped result success");
						resultRenderedDuringTurn = true;
					}
				},
				onTerminal: ignore,
				onViewState: ignore,
			},
			execution,
			messages: [
				{
					id: sourceMessageId,
					metadata: { agent: agentId, model: selectedModel },
					parts: [{ text: "Use the turn-scoped fixture Tool.", type: "text" }],
					role: "user",
				},
			],
			prepareNextStep: async () => undefined,
			resolvedAgent: {
				displayName: "Build",
				id: agentId,
				instructions: "Use the available fixture Tool.",
				role: "primary",
				visibleCodingTools: [],
			},
			signal: new AbortController().signal,
			takeSteeringMessages: async () => [],
		});

		expect(callRenderedDuringTurn).toBe(true);
		expect(resultRenderedDuringTurn).toBe(true);
		expect(modelSteps).toBe(2);
		expect(outcome.error).toBeUndefined();
		expect(outcome.turn).toBeDefined();
		if (turnToolName === undefined) {
			throw new Error("The deterministic model did not call the turn Tool.");
		}
		const descriptorsAfterTurnEnd = environment.runtime.getToolDescriptors(
			environment.sessionId,
			{ includeTurnRenderers: true }
		);
		expect(
			descriptorsAfterTurnEnd.some((tool) => tool.name === turnToolName)
		).toBe(false);
		expect(
			descriptorsAfterTurnEnd.some(
				(tool) =>
					tool.localName === "session_scoped" && tool.renderCall !== undefined
			)
		).toBe(true);

		const assistantMessage = projectedMessages.find(
			({ id }) => id === execution.assistantId
		);
		const resultPart = assistantMessage?.parts.find(
			(part): part is DynamicToolPart =>
				part.type === "dynamic-tool" && part.state === "output-available"
		);
		if (resultPart === undefined) {
			throw new Error(
				"The real turn did not retain the completed Tool result."
			);
		}
		await act(() => environment.updateParts([{ ...resultPart }]));
		await flushTestRenderer(environment.setup, 2);
		const fallbackFrame = environment.setup.captureCharFrame();
		expect(fallbackFrame).toContain(turnToolName);
		expect(fallbackFrame).not.toContain("turn-scoped call");
		expect(fallbackFrame).not.toContain("turn-scoped result");

		const sessionTool = descriptorsAfterTurnEnd.find(
			(tool) => tool.localName === "session_scoped"
		);
		if (sessionTool?.renderCall === undefined) {
			throw new Error(
				"The Session-scoped Plugin Tool renderer was not retained."
			);
		}
		await act(() =>
			environment.updateParts([
				{
					input: { query: "WCO-288" },
					state: "input-available",
					toolCallId: toolCallId("plugin-session-scoped-after-turn-call"),
					toolName: sessionTool.name,
					type: "dynamic-tool",
				},
			])
		);
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain(
			"session-scoped call input-available"
		);
	} finally {
		await statefulAgent.shutdown();
		await providerCollection.close();
		await environment.dispose();
	}
});

test("the verified Plugin Tool renderer example uses the public call/result contract", async () => {
	const environment = await createRendererEnvironment(
		pluginToolRendererExample,
		"tool_renderer_example"
	);
	try {
		const descriptor = environment.runtime
			.getToolDescriptors(environment.sessionId)
			.find((tool) => tool.localName === "lookup");
		if (descriptor === undefined) {
			throw new Error("The example Plugin Tool was not registered.");
		}
		expect(descriptor.renderCall).toBeDefined();
		expect(descriptor.renderResult).toBeDefined();
		expect(descriptor.ownsRowShell).toBeUndefined();

		const tool = createPluginTools({
			agentId: agentIdSchema.parse("build"),
			pluginRuntime: environment.runtime,
			pluginTools: environment.runtime.getToolDescriptors(
				environment.sessionId
			),
			sessionId: environment.sessionId,
			workspace: environment.workspace,
		}).find(({ definition }) => definition.name === descriptor.name);
		if (tool === undefined) {
			throw new Error("The example Plugin Tool was not executable.");
		}
		const outcome = await tool.execute({
			input: { query: "WCO-288" },
			toolCallId: toolCallId("plugin-tool-example-call"),
		});
		if (outcome.type !== "success") {
			throw new Error(`The example Tool failed: ${outcome.errorText}`);
		}
		await act(() =>
			environment.updateParts([
				{
					input: { query: "WCO-288" },
					output: outcome.output,
					state: "output-available",
					toolCallId: toolCallId("plugin-tool-example-call"),
					toolName: descriptor.name,
					type: "dynamic-tool",
				},
			])
		);
		await flushTestRenderer(environment.setup, 2);

		const frame = environment.setup.captureCharFrame();
		expect(frame).toContain("Searching WCO-288 · output-available");
		expect(frame).toContain("Answer for WCO-288");
		expect(frame).toContain("Ctrl+O expands");
	} finally {
		await environment.dispose();
	}
});

test("a Plugin call renderer error restores the host row without rerunning the Tool", async () => {
	resetPluginToolRendererFixtureState();
	const environment = await createRendererEnvironment();
	try {
		await act(() =>
			environment.updateParts([
				{
					input: { failCallPresentation: true, query: "WCO-288" },
					state: "input-available",
					toolCallId: toolCallId("plugin-tool-renderer-call"),
					toolName: environment.toolName,
					type: "dynamic-tool",
				},
			])
		);
		await flushTestRenderer(environment.setup, 2);

		const fallbackFrame = environment.setup.captureCharFrame();
		expect(fallbackFrame).toContain("⚙ plugin_tool_renderer_fixture_lookup");
		expect(fallbackFrame).not.toContain("fixture call input-available");
		expect(pluginToolRendererFixtureState.executionCount).toBe(0);
		expect(pluginToolRendererFixtureState.callUnmounts).toBe(1);

		const tool = createPluginTools({
			agentId: agentIdSchema.parse("build"),
			pluginRuntime: environment.runtime,
			pluginTools: environment.runtime.getToolDescriptors(
				environment.sessionId
			),
			sessionId: environment.sessionId,
			workspace: environment.workspace,
		}).find(({ definition }) => definition.name === environment.toolName);
		if (tool === undefined) {
			throw new Error("The fixture Plugin Tool was not executable.");
		}
		const result = await tool.execute({
			input: { query: "WCO-288" },
			toolCallId: toolCallId("plugin-tool-renderer-call"),
		});
		expect(result.type).toBe("success");
		expect(pluginToolRendererFixtureState.executionCount).toBe(1);
		await flushTestRenderer(environment.setup, 2);
		expect(pluginToolRendererFixtureState.executionCount).toBe(1);
	} finally {
		await environment.dispose();
	}
});

test("a Plugin result renderer error restores the default presentation without changing the result", async () => {
	resetPluginToolRendererFixtureState();
	const environment = await createRendererEnvironment();
	try {
		const tool = createPluginTools({
			agentId: agentIdSchema.parse("build"),
			pluginRuntime: environment.runtime,
			pluginTools: environment.runtime.getToolDescriptors(
				environment.sessionId
			),
			sessionId: environment.sessionId,
			workspace: environment.workspace,
		}).find(({ definition }) => definition.name === environment.toolName);
		if (tool === undefined) {
			throw new Error("The fixture Plugin Tool was not executable.");
		}
		const result = await tool.execute({
			input: { failResultPresentation: true, query: "WCO-288" },
			toolCallId: toolCallId("plugin-tool-renderer-call"),
		});
		if (result.type !== "success") {
			throw new Error(`The fixture Tool failed: ${result.errorText}`);
		}
		const storedOutput = structuredClone(result.output);
		await act(() =>
			environment.updateParts([
				{
					input: { failResultPresentation: true, query: "WCO-288" },
					output: result.output,
					state: "output-available",
					toolCallId: toolCallId("plugin-tool-renderer-call"),
					toolName: environment.toolName,
					type: "dynamic-tool",
				},
			])
		);
		await flushTestRenderer(environment.setup, 2);

		const fallbackFrame = environment.setup.captureCharFrame();
		expect(fallbackFrame).toContain("⚙ plugin_tool_renderer_fixture_lookup");
		expect(fallbackFrame).not.toContain("fixture result");
		expect(pluginToolRendererFixtureState.executionCount).toBe(1);
		expect(pluginToolRendererFixtureState.resultMounts).toBe(0);
		expect(result.output).toEqual(storedOutput);
	} finally {
		await environment.dispose();
	}
});

test("noninteractive Plugin Tool execution returns data without executing React renderers", async () => {
	resetPluginToolRendererFixtureState();
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-plugin-tool-noninteractive-")
	);
	const workspace = path.join(root, "workspace");
	await fs.mkdir(workspace, { recursive: true });
	const sessionId = toSessionId("plugin-tool-renderer-print-session");
	const runtime = await loadPlugins({
		bundledPlugins: [
			{ factory: pluginToolRendererFixture, id: "tool_renderer_fixture" },
		],
		cliPaths: [],
		config: {
			configStore: createConfigStore({ homeRoot: root }),
			cwd: workspace,
			homeRoot: root,
			workspace,
		},
		userDataDir: root,
	});
	try {
		await runtime.startSession({
			executionMode: "print",
			sessionId,
			workspace,
		});
		const descriptor = runtime
			.getToolDescriptors(sessionId)
			.find((tool) => tool.localName === "lookup");
		if (descriptor === undefined) {
			throw new Error("The fixture Plugin Tool was not registered.");
		}
		const tool = createPluginTools({
			agentId: agentIdSchema.parse("build"),
			pluginRuntime: runtime,
			pluginTools: [descriptor],
			sessionId,
			workspace,
		})[0];
		if (tool === undefined) {
			throw new Error("The fixture Plugin Tool was not executable.");
		}
		const result = await tool.execute({
			input: { query: "print-mode" },
			toolCallId: toolCallId("plugin-tool-noninteractive-call"),
		});

		expect(result).toEqual({
			output: {
				answer: "result for print-mode",
				failResultPresentation: false,
				mutatePresentation: false,
			},
			type: "success",
		});
		expect(pluginToolRendererFixtureState.executionCount).toBe(1);
		expect(pluginToolRendererFixtureState.callStates).toEqual([]);
		expect(pluginToolRendererFixtureState.resultStates).toEqual([]);
		expect(pluginToolRendererFixtureState.callMounts).toBe(0);
		expect(pluginToolRendererFixtureState.resultMounts).toBe(0);
	} finally {
		await runtime.stopSession({ executionMode: "print", sessionId, workspace });
		await runtime.shutdown();
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("Plugin renderer mutations cannot alter the Session Tool result", async () => {
	resetPluginToolRendererFixtureState();
	const environment = await createRendererEnvironment();
	try {
		const tool = createPluginTools({
			agentId: agentIdSchema.parse("build"),
			pluginRuntime: environment.runtime,
			pluginTools: environment.runtime.getToolDescriptors(
				environment.sessionId
			),
			sessionId: environment.sessionId,
			workspace: environment.workspace,
		}).find(({ definition }) => definition.name === environment.toolName);
		if (tool === undefined) {
			throw new Error("The fixture Plugin Tool was not executable.");
		}
		const result = await tool.execute({
			input: { mutateResult: true, query: "WCO-288" },
			toolCallId: toolCallId("plugin-tool-renderer-mutation-call"),
		});
		if (result.type !== "success") {
			throw new Error(`The fixture Tool failed: ${result.errorText}`);
		}
		const part: DynamicToolPart = {
			input: { mutateResult: true, query: "WCO-288" },
			output: result.output,
			state: "output-available",
			toolCallId: toolCallId("plugin-tool-renderer-mutation-call"),
			toolName: environment.toolName,
			type: "dynamic-tool",
		};
		const storedOutput = structuredClone(part.output);
		await act(() => environment.updateParts([part]));
		await flushTestRenderer(environment.setup, 2);

		expect(environment.setup.captureCharFrame()).toContain(
			"mutated by renderer"
		);
		expect(part.output).toEqual(storedOutput);
		expect(pluginToolRendererFixtureState.executionCount).toBe(1);
	} finally {
		await environment.dispose();
	}
});
