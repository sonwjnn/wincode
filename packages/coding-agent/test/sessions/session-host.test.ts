import { afterAll, describe, expect, mock, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The Host opens the store its capabilities hand it, so this test runs against
 * a real local store of its own: a temporary directory nothing else in the
 * process shares.
 */
const testDirectory = mkdtempSync(join(tmpdir(), "wincode-session-host-"));
const previousSubagentsDatabasePath = process.env.WINCODE_SUBAGENTS_DB_PATH;
process.env.WINCODE_SUBAGENTS_DB_PATH = join(testDirectory, "subagents.sqlite");

import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import {
	type AgentTurnEvent,
	createOperationalFailure,
	type SessionRecord,
} from "@wincode/agent-core";
import type {
	ModelStepRequest,
	ModelStreamPart,
} from "@wincode/ai/model-client";
import type { ChatModelSelection } from "@wincode/ai/models";
import {
	createMcpRegistry,
	type McpClient,
	type McpConfigResult,
	qualifyMcpToolName,
	type ResolvedMcpServerConfig,
} from "@wincode/mcp";
import { logger } from "@wincode/utils";
import { z } from "zod";
import type { ResolvedCodingAgent } from "@/modules/agents/built-ins";
import { buildAgentRegistry } from "@/modules/agents/registry";
import { createApplicationPluginComposition } from "@/modules/application/plugin-composition";
import {
	createMcpSessionCapability,
	type McpPluginResource,
} from "@/modules/mcp/capability";
import { loadPlugins } from "@/modules/plugins/loader";
import {
	createPluginRuntime,
	type LoadedPlugin,
	type PluginRuntime,
} from "@/modules/plugins/runtime";
import type {
	SessionSteeringAdmission,
	SessionSubmissionAdmission,
	SessionSubmissionEvent,
} from "@/modules/sessions/agent-session/types";
import { createSessionCompaction } from "@/modules/sessions/compaction/compaction";
import type { ResolvedCompactionSettings } from "@/modules/sessions/compaction/config";
import { compactionSummaryMessageId } from "@/modules/sessions/compaction/summary-message";
import type {
	AppendSessionCompactionInput,
	SummaryGenerator,
} from "@/modules/sessions/compaction/types";
import { createSessionHostManager as createSessionHostManagerWithRuntime } from "@/modules/sessions/host/session-host-manager";
import type {
	SessionCapabilities,
	SessionHost,
	SessionHostManager,
} from "@/modules/sessions/host/types";
import type {
	SessionFilePart,
	SessionMessage,
} from "@/modules/sessions/message";
import { createSessionSdkChildFactory } from "@/modules/sessions/sdk";
import type { SessionSdkChildFactory } from "@/modules/sessions/sdk-contract";
import {
	buildUserSessionRecord,
	projectSessionRecords,
} from "@/modules/sessions/storage/session-record";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import type { SessionWriterLock } from "@/modules/sessions/storage/session-writer-lock";
import type { SessionSendInput } from "@/modules/sessions/submission-types";
import { createMcpPluginFactory } from "@/plugins/mcp";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import { createConfigStore } from "@/shared/config/config-store";
import type { CompactionId, SessionId } from "@/shared/identifiers";
import {
	readLoggerRecords,
	withDebugProject,
	withLoggerHome,
} from "../../../utils/test/logger-home";
import {
	createFakeModelClientModule,
	createFakeModelClientRecorder,
} from "../support/e2e-fake-runtime";
import {
	agentId,
	agentTurnId,
	compactionId,
	modelId,
	sessionMessageId,
	sessionRecordId,
	toolCallId,
} from "../support/identifiers";

const recorder = createFakeModelClientRecorder();
// The module mock must be installed before the production Session Host graph
// loads, so the Agent Runtime the Host composes is the fake one. The production
// modules are imported dynamically for that reason alone.
await mock.module("@wincode/ai/model-client", () =>
	createFakeModelClientModule(recorder)
);

const { createSessionHost } = await import(
	"@/modules/sessions/host/session-host"
);
const { createDatabase } = await import("@/modules/sessions/storage/client");
const { createDrizzleSessionStore } = await import(
	"@/modules/sessions/storage/drizzle-session-store"
);
const { createPermissionService } = await import(
	"@/modules/permissions/permission-service"
);
const { createToolPermissionPolicyState, createToolPermissionRuntime } =
	await import("@/modules/permissions/tool-permission-runtime");
const createSessionHostManager = () => createSessionHostManagerWithRuntime();
const sessionHostManager = createSessionHostManager();

const model: ChatModelSelection = {
	modelId: modelId("gpt-5.6-luna"),
	providerId: "openai",
};
const buildId = agentId("build");
const COMPACTION_SUMMARY_TEXT = "the first turn, summarized";
const store = createDrizzleSessionStore(
	createDatabase(join(testDirectory, "sessions.db")).db,
	{
		attachmentRoot: join(testDirectory, "attachments"),
		workspaceRoot: process.cwd(),
	}
);

const message = (
	id: string,
	role: "assistant" | "user",
	text: string
): SessionMessage => ({
	id: sessionMessageId(id),
	parts: [{ text, type: "text" }],
	role,
});

const completedOutcome = (): SessionRecord["outcome"] => ({
	kind: "assistant",
	terminal: {
		finishedAt: 2,
		kind: "completed",
		usage: { inputTokens: 1, outputTokens: 1 },
	},
});

/**
 * Seeds one session with a completed first turn and a caller-selected second
 * turn, plus a compaction boundary between them.
 */
const seedSession = async (
	prefix: string,
	secondTurnState: "completed" | "interrupted" = "interrupted"
): Promise<{
	compaction: CompactionId;
	sessionId: SessionId;
}> => {
	const firstUser = message(`${prefix}-user-1`, "user", "first request");
	const { id: sessionId } = await store.createSession({
		agent: buildId,
		message: firstUser,
		model,
		turnId: agentTurnId(`${prefix}-turn-1`),
	});
	await store.commitSessionRecord({
		record: {
			agentId: buildId,
			id: sessionRecordId(`${prefix}-record-1`),
			messages: [
				{
					id: sessionMessageId(`${prefix}-assistant-1`),
					parts: [{ text: "first answer", type: "text" }],
					role: "assistant",
				},
			],
			model,
			outcome: completedOutcome(),
			turnId: agentTurnId(`${prefix}-turn-1`),
			version: 1,
		},
		sessionId,
	});
	const secondUser = message(`${prefix}-user-2`, "user", "second request");
	await store.commitSessionRecord({
		record: buildUserSessionRecord({
			agentId: buildId,
			message: secondUser,
			model,
			turnId: agentTurnId(`${prefix}-turn-2`),
		}),
		sessionId,
	});
	await store.commitSessionRecord({
		record: {
			agentId: buildId,
			id: sessionRecordId(`${prefix}-record-3`),
			messages: [
				{
					id: sessionMessageId(`${prefix}-assistant-2`),
					parts: [
						{
							text:
								secondTurnState === "completed"
									? "second answer"
									: "half an answer",
							type: "text",
						},
					],
					role: "assistant",
				},
			],
			model,
			outcome:
				secondTurnState === "completed"
					? completedOutcome()
					: {
							kind: "assistant",
							terminal: {
								failure: createOperationalFailure({
									code: "interrupted",
									retry: "never",
									source: "runtime",
								}),
								finishedAt: 3,
								kind: "interrupted",
								reason: "user",
							},
						},
			turnId: agentTurnId(`${prefix}-turn-2`),
			version: 1,
		},
		sessionId,
	});
	const compaction = await store.appendCompaction({
		estimatedTokensAfter: 100,
		firstKeptUiMessageId: sessionMessageId(`${prefix}-user-2`),
		sessionId,
		summarizationModel: model,
		summary: {
			coveredMessageIds: [sessionMessageId(`${prefix}-user-1`)],
			formatVersion: 1,
			text: COMPACTION_SUMMARY_TEXT,
		},
		throughMessageUiId: sessionMessageId(`${prefix}-assistant-1`),
		tokensBefore: 900,
		trigger: "threshold",
	} satisfies AppendSessionCompactionInput);
	return {
		compaction: compaction.id,
		sessionId,
	};
};

const compactionModule = (summaryGenerator: SummaryGenerator) =>
	createSessionCompaction({
		estimateTokens: (messages) => messages.length,
		generateId: () => compactionId("entry-compacted"),
		store: {
			appendCompaction: async (input: AppendSessionCompactionInput) => ({
				...input,
				completedAt: new Date("2026-09-01T00:00:00.000Z"),
				createdAt: new Date("2026-09-01T00:00:00.000Z"),
				id: input.id ?? compactionId("entry-compacted"),
				sequence: 1,
			}),
			getLatestCompaction: async () => null,
		},
		summaryGenerator,
	});

/**
 * The capabilities one Host runs against outside React: the workspace config,
 * a connection that authorizes the Model Target, an empty MCP catalog, the
 * built-in Agent registry, the Tool Permission runtime, and the Session
 * Compaction module the Agent Session contract tests fake the same way.
 */
type SessionHostTestCapabilitiesOptions = Readonly<{
	configSources?: ConfigSnapshot["sources"];
	homeRoot?: string;
	workspace?: string;
	pluginRuntime?: PluginRuntime;
}>;

const bundledComposition = createApplicationPluginComposition({
	createMcpResource: false,
	enabledPlugins: ["mcp", "subagents"],
	workspace: testDirectory,
});
const bundledPluginRuntime = await loadPlugins({
	bundledPlugins: bundledComposition.bundledPlugins,
	cliPaths: [],
	config: {
		configStore: createConfigStore({
			configRoot: join(testDirectory, "config"),
			homeRoot: testDirectory,
		}),
		cwd: testDirectory,
		homeRoot: testDirectory,
		workspace: testDirectory,
	},
});

const createCapabilities = (
	sessionStore: SessionStore = store,
	document: ConfigSnapshot["document"] = {},
	manager: SessionHostManager = sessionHostManager,
	options: SessionHostTestCapabilitiesOptions = {}
): SessionCapabilities => {
	const workspace = options.workspace ?? process.cwd();
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document,
			sourceFor: () => undefined,
			sources: options.configSources ?? [],
		})
	);
	const config = {
		configStore: createConfigStore({
			fs: {
				readFile: async () => {
					throw Object.assign(new Error("Test config is unavailable."), {
						code: "ENOENT",
					});
				},
			},
		}),
		cwd: workspace,
		homeRoot: options.homeRoot ?? homedir(),
		workspace,
	};
	const toolPermission = createToolPermissionRuntime({
		agent: buildId,
		policyState: createToolPermissionPolicyState(),
		registry,
		service: createPermissionService(),
		workspace,
	});
	const pluginRuntime = options.pluginRuntime ?? bundledPluginRuntime;
	const composition = createApplicationPluginComposition({
		configStore: config.configStore,
		createMcpResource: false,
		enabledPlugins: ["mcp", "subagents"],
		workspace,
	});
	let sessionSdk: SessionSdkChildFactory | undefined;
	const capabilities: SessionCapabilities = {
		getCapabilityCeiling: () => undefined,
		getCompactionModule: () =>
			compactionModule(async () => ({ text: "summary" })),
		getCompactionSettings: async () =>
			fromPartial<ResolvedCompactionSettings>({
				autoAvailable: false,
				enabled: true,
				keepRecentTokens: 1,
				maxMediaAttachments: 4,
				maxMediaBytes: 1024,
				maxMediaTokens: 128,
				modelContextLimit: 200_000,
				overflowRecoveryAvailable: false,
				reserveTokens: 1000,
				thresholdTokens: null,
			}),
		getConfig: () => config,
		getConnections: () => ({
			authorize: async () => ({
				apiKey: "session-host-key",
				kind: "api-key" as const,
			}),
			connect: async () => undefined,
			listProviders: async () => [],
		}),
		getRegistry: () => registry,
		getStore: () => sessionStore,
		getSessionHostManager: () => manager,
		getSessionSdk: () => sessionSdk,
		getPluginRuntime: () => pluginRuntime,
		getToolPermission: () => toolPermission,
		getTurnToolResolver: () => composition.turnToolResolver,
	};
	sessionSdk = createSessionSdkChildFactory(
		{
			configRuntime: config,
			connections: capabilities.getConnections(),
			cwd: workspace,
			enabledPlugins: ["mcp", "subagents"],
			registry,
			store: sessionStore,
			workspace,
		},
		manager,
		sessionStore
	);
	return capabilities;
};

test("Session Host opening waits for asynchronous Session Plugin registrations", async () => {
	const sessionStart = Promise.withResolvers<void>();
	const finishRegistration = Promise.withResolvers<void>();
	let openingResolved = false;
	const plugin: LoadedPlugin = {
		commands: [],
		id: "session-start-ready",
		onSessionStart: async (_context, api) => {
			sessionStart.resolve();
			await finishRegistration.promise;
			api.registerTool({
				description: "A Session-start registration.",
				handler: async () => ({ output: {}, type: "success" }),
				inputSchema: z.object({}),
				name: "session_ready",
			});
		},
		sourcePath: "/plugins/session-start-ready.ts",
		tools: [],
		workspace: testDirectory,
	};
	const pluginRuntime = createPluginRuntime([plugin], []);
	const manager = createSessionHostManagerWithRuntime(pluginRuntime);
	const capabilities = createCapabilities(store, {}, manager, {
		pluginRuntime,
	});
	const { id: openedSessionId } = await store.createSession({
		agent: buildId,
		message: message(
			"session-start-readiness-user",
			"user",
			"Open before Plugin registration completes."
		),
		model,
		turnId: agentTurnId("session-start-readiness-turn"),
	});
	const opening = manager.openHost({
		autoContinue: false,
		capabilities,
		sessionId: openedSessionId,
		view: true,
	});
	void opening.then(() => {
		openingResolved = true;
	});

	try {
		await sessionStart.promise;
		await Bun.sleep(0);
		expect(openingResolved).toBe(false);
		expect(pluginRuntime.getToolDescriptors(openedSessionId)).toEqual([]);

		finishRegistration.resolve();
		await opening;
		expect(
			pluginRuntime
				.getToolDescriptors(openedSessionId)
				.map(({ localName }) => localName)
		).toEqual(["session_ready"]);
		await manager.releaseView(openedSessionId);
	} finally {
		finishRegistration.resolve();
		await manager.shutdownAll();
		await pluginRuntime.shutdown();
	}
});

test("Plugin lifecycle restarts for a reopened Session runtime", async () => {
	const events: string[] = [];
	const plugin: LoadedPlugin = {
		commands: [],
		id: "jira",
		onSessionShutdown: ({ sessionId }) => {
			events.push(`stop:${sessionId}`);
		},
		onSessionStart: ({ sessionId }) => {
			events.push(`start:${sessionId}`);
		},
		onShutdown: () => {
			events.push("process-stop");
		},
		sourcePath: "/plugins/jira.ts",
		tools: [],
		workspace: testDirectory,
	};
	const pluginRuntime = createPluginRuntime([plugin], []);
	const manager = createSessionHostManagerWithRuntime(pluginRuntime);
	const capabilities = createCapabilities(store, {}, manager, {
		pluginRuntime,
		workspace: testDirectory,
	});
	const { id: openedSessionId } = await store.createSession({
		agent: buildId,
		message: message("plugin-lifecycle-user", "user", "Open the issue."),
		model,
		turnId: agentTurnId("plugin-lifecycle-turn"),
	});

	await manager.openHost({
		capabilities,
		sessionId: openedSessionId,
		view: true,
	});
	await manager.releaseView(openedSessionId);
	await manager.openHost({
		capabilities,
		sessionId: openedSessionId,
		view: true,
	});
	await manager.releaseView(openedSessionId);
	await manager.shutdownAll();
	await pluginRuntime.shutdown();

	expect(events).toEqual([
		`start:${openedSessionId}`,
		`stop:${openedSessionId}`,
		`start:${openedSessionId}`,
		`stop:${openedSessionId}`,
		"process-stop",
	]);
});

const createHostMcpRegistry = (executedServers: string[]) => {
	const serverConfigs: ResolvedMcpServerConfig[] = [
		"server-denied",
		"agent-denied",
		"allowed",
	].map(
		(name): ResolvedMcpServerConfig => ({
			name,
			type: "local",
			command: ["unused-host-test-command"],
			disabled: false,
			permission: name === "server-denied" ? "deny" : "allow",
			timeout: { startup: 1000, catalog: 1000, execution: 1000 },
		})
	);
	return createMcpRegistry({
		createClient: (config): McpClient => ({
			callTool: async (toolName) => {
				executedServers.push(config.name);
				return fromAny({
					content: [{ text: `${config.name}:${toolName}`, type: "text" }],
					isError: false,
				});
			},
			close: async () => undefined,
			connect: async () => undefined,
			listTools: async () => [
				{
					description: "Echo text through the test MCP server.",
					inputSchema: {
						properties: { text: { type: "string" } },
						required: ["text"],
						type: "object",
					},
					name: "echo",
				},
			],
			setToolsChangedListener: () => undefined,
		}),
		env: {},
		loadConfig: async (): Promise<McpConfigResult> => ({
			diagnostics: [],
			servers: Object.fromEntries(
				serverConfigs.map((config) => [config.name, config])
			),
		}),
		workspace: process.cwd(),
	});
};

const createDelayedTerminalStore = (base: SessionStore) => {
	const terminalCommitStarted = Promise.withResolvers<void>();
	const allowTerminalCommit = Promise.withResolvers<void>();
	let blocksTerminalCommit = true;
	const delayed: SessionStore = {
		...base,
		commitSessionRecord: async (input) => {
			if (blocksTerminalCommit && input.record.outcome.kind === "assistant") {
				blocksTerminalCommit = false;
				terminalCommitStarted.resolve();
				await allowTerminalCommit.promise;
			}
			await base.commitSessionRecord(input);
		},
	};
	return { allowTerminalCommit, delayed, terminalCommitStarted };
};

const resolvedAgentOf = (
	capabilities: SessionCapabilities
): ResolvedCodingAgent => {
	const agent = capabilities
		.getRegistry()
		?.selectableAgents.find(({ id }) => id === buildId);
	if (!agent) {
		throw new Error("The build Agent is missing from the registry.");
	}
	return fromPartial<ResolvedCodingAgent>({ ...agent });
};

const sendInput = (
	capabilities: SessionCapabilities,
	userText = "third request"
): SessionSendInput => ({
	agent: buildId,
	composition: { files: [], text: userText },
	model,
	resolvedAgent: resolvedAgentOf(capabilities),
	sessionModel: model,
	userText,
});

const textOf = (parts: SessionMessage["parts"]): string =>
	parts.map((part) => (part.type === "text" ? part.text : "")).join("");

afterAll(async () => {
	await sessionHostManager.shutdownAll();
	await bundledPluginRuntime.shutdown();
	if (previousSubagentsDatabasePath === undefined) {
		delete process.env.WINCODE_SUBAGENTS_DB_PATH;
	} else {
		process.env.WINCODE_SUBAGENTS_DB_PATH = previousSubagentsDatabasePath;
	}
	rmSync(testDirectory, { force: true, recursive: true });
});

test("retains an idle Session Host until registered Plugin background work finishes", async () => {
	const background = Promise.withResolvers<void>();
	let shutdownCount = 0;
	const plugin: LoadedPlugin = {
		commands: [],
		id: "background_work",
		onSessionShutdown: async () => {
			shutdownCount += 1;
		},
		sourcePath: "/plugins/background-work.ts",
		tools: [],
		workspace: testDirectory,
	};
	const pluginRuntime = createPluginRuntime([plugin], []);
	const manager = createSessionHostManager();
	const capabilities = createCapabilities(store, {}, manager, {
		pluginRuntime,
		workspace: testDirectory,
	});
	const { id: parentSessionId } = await store.createSession({
		agent: buildId,
		message: message(
			"background-work-parent-user",
			"user",
			"Keep this Session host alive while Plugin work remains."
		),
		model,
		turnId: agentTurnId("background-work-parent-turn"),
	});
	pluginRuntime.registerBackgroundWork(parentSessionId, background.promise);
	const host = await manager.openHost({
		capabilities,
		sessionId: parentSessionId,
		view: true,
	});

	await manager.releaseView(parentSessionId);
	const reopenedHost = await manager.openHost({
		capabilities,
		sessionId: parentSessionId,
	});
	expect(reopenedHost).toBe(host);
	expect(shutdownCount).toBe(0);

	background.resolve();
	await pluginRuntime.waitForBackgroundWork(parentSessionId);
	await manager.releaseView(parentSessionId);
	expect(shutdownCount).toBe(1);
	await manager.shutdownAll();
	await pluginRuntime.shutdown();
});

test("MCP Plugin composes tool visibility from Agent and server policies", async () => {
	const executedServers: string[] = [];
	const mcpRegistry = createHostMcpRegistry(executedServers);
	const mcpResource: McpPluginResource = Object.freeze({
		capability: Object.freeze(createMcpSessionCapability(mcpRegistry)),
		close: () => mcpRegistry.close(),
		initialize: () => mcpRegistry.initialize(),
		registry: mcpRegistry,
	});
	const pluginRuntime = await loadPlugins({
		bundledPlugins: [
			...bundledComposition.bundledPlugins.filter(({ id }) => id !== "mcp"),
			{ factory: createMcpPluginFactory(mcpResource), id: "mcp" },
		],
		cliPaths: [],
		config: {
			configStore: createConfigStore({
				configRoot: join(testDirectory, "config"),
				homeRoot: testDirectory,
			}),
			cwd: testDirectory,
			homeRoot: testDirectory,
			workspace: testDirectory,
		},
	});
	const manager = createSessionHostManager();
	const configDocument = {
		agents: {
			build: {
				permission: {
					"server-denied_echo": "allow",
					"agent-denied_echo": "deny",
				},
			},
		},
	};
	const capabilities = createCapabilities(store, configDocument, manager, {
		configSources: [
			{
				document: configDocument,
				path: join(testDirectory, "mcp-policy.json"),
				scope: "project",
			},
		],
		pluginRuntime,
	});
	const { id: sessionId } = await store.createSession({
		agent: buildId,
		message: message(
			"mcp-policy-composition-user",
			"user",
			"Use the available MCP server and report its result."
		),
		model,
		turnId: agentTurnId("mcp-policy-composition-turn"),
	});
	const host = await manager.openHost({ capabilities, sessionId });
	const allowedToolName = await qualifyMcpToolName("allowed", "echo");
	let visibleMcpTools: string[] = [];
	let returnedToModel = false;
	const previousStepScript = recorder.stepScript;
	recorder.stepScript = async function* (
		request: ModelStepRequest
	): AsyncGenerator<ModelStreamPart> {
		visibleMcpTools = (request.tools ?? [])
			.filter(({ name }) => name.startsWith("mcp_"))
			.map(({ name }) => name);
		const hasToolResult = request.messages
			.flatMap(({ content }) => content)
			.some(({ type }) => type === "tool-result");
		if (hasToolResult) {
			returnedToModel = true;
			yield {
				delta: "The allowed MCP result was received.",
				type: "text-delta",
			};
		} else {
			yield {
				input: { text: "through host" },
				toolCallId: toolCallId("mcp-policy-composition-call"),
				toolName: allowedToolName,
				type: "tool-call",
			};
		}
		yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
	};

	try {
		const outcome = await host.agentSession.send(
			sendInput(
				capabilities,
				"Use the available MCP server and report its result."
			)
		);

		expect(outcome.rejected).toBe(false);
		expect(visibleMcpTools).toEqual([allowedToolName]);
		expect(executedServers).toEqual(["allowed"]);
		expect(returnedToModel).toBe(true);
	} finally {
		recorder.stepScript = previousStepScript;
		await manager.shutdownAll();
		await pluginRuntime.shutdown();
	}
});

test("Session Host reports an unavailable Skill target without activating it", async () => {
	const workspace = join(testDirectory, "unavailable-skill-workspace");
	const availableSkillBody = "Do not load this unrelated available Skill.";
	await Bun.write(
		join(workspace, ".wincode", "skills", "available", "SKILL.md"),
		`---\nname: available\ndescription: An unrelated available Skill.\n---\n${availableSkillBody}`
	);
	const manager = createSessionHostManager();
	const capabilities = createCapabilities(store, {}, manager, {
		homeRoot: workspace,
		workspace,
	});
	const { id: sessionId } = await store.createSession({
		agent: buildId,
		message: message(
			"unavailable-skill-user",
			"user",
			"Try the unavailable Skill and report its status."
		),
		model,
		turnId: agentTurnId("unavailable-skill-turn"),
	});
	const host = await manager.openHost({ capabilities, sessionId });
	const previousStepScript = recorder.stepScript;
	let modelStep = 0;
	let skillToolVisible = false;
	let skillResult: unknown;
	let availableSkillBodyLoaded = false;
	recorder.stepScript = async function* (
		request: ModelStepRequest
	): AsyncGenerator<ModelStreamPart> {
		modelStep += 1;
		if (modelStep === 1) {
			skillToolVisible = (request.tools ?? []).some(
				({ name }) => name === "skill"
			);
			yield {
				input: { name: "not-in-catalog" },
				toolCallId: toolCallId("unavailable-skill-call"),
				toolName: "skill",
				type: "tool-call",
			};
		} else {
			const result = request.messages
				.flatMap(({ content }) => content)
				.find(({ type }) => type === "tool-result");
			skillResult = result?.type === "tool-result" ? result.output : undefined;
			availableSkillBodyLoaded =
				request.system?.includes(availableSkillBody) ?? false;
			yield {
				delta: "The requested Skill was unavailable.",
				type: "text-delta",
			};
		}
		yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
	};

	try {
		const outcome = await host.agentSession.send(
			sendInput(
				capabilities,
				"Try the unavailable Skill and report its status."
			)
		);

		expect(outcome.rejected).toBe(false);
		expect(skillToolVisible).toBe(true);
		expect(modelStep).toBe(2);
		expect(JSON.stringify(skillResult)).toContain("Unknown Skill");
		expect(JSON.stringify(skillResult)).toContain('"status":"failed"');
		expect(availableSkillBodyLoaded).toBe(false);
		expect(host.agentSession.getSnapshot().approvals).toEqual([]);
	} finally {
		recorder.stepScript = previousStepScript;
		await manager.shutdownAll();
	}
});

describe("Session Host opening", () => {
	test("opens the transcript, context, compactions, and Session Selection a consumer reads", async () => {
		const seeded = await seedSession("open");
		const capabilities = createCapabilities();
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});

		const snapshot = host.getSnapshot();

		expect(snapshot.transcript.map(({ id }) => id)).toEqual([
			sessionMessageId("open-user-1"),
			sessionMessageId("open-assistant-1"),
			sessionMessageId("open-user-2"),
			sessionMessageId("open-assistant-2"),
		]);
		// An interrupted turn keeps its Session Record and reads as interrupted.
		expect(snapshot.transcript[3]?.metadata?.terminalOutcome).toBe(
			"interrupted"
		);
		// The Session Context is rebuilt around the latest compaction: its summary
		// stands in for covered messages, and only primary records remain.
		expect(snapshot.context.map(({ id }) => id)).toEqual([
			compactionSummaryMessageId(seeded.compaction),
			sessionMessageId("open-user-2"),
			sessionMessageId("open-assistant-2"),
		]);
		expect(textOf(snapshot.context[0]?.parts ?? [])).toContain(
			COMPACTION_SUMMARY_TEXT
		);
		expect(snapshot.compactions.map(({ id }) => id)).toEqual([
			seeded.compaction,
		]);
		// The session exposes what its next turn runs with.
		expect(host.getSelection()).toEqual({
			agent: buildId,
			model,
			persistedAgent: buildId,
			effort: undefined,
			reasoningMode: undefined,
		});

		await host.shutdown();
	});
	test("refuses a second Host while the first Host owns the Session", async () => {
		const seeded = await seedSession("contention");
		const secondDatabase = createDatabase(join(testDirectory, "sessions.db"));
		const secondStore = createDrizzleSessionStore(secondDatabase.db, {
			attachmentRoot: join(testDirectory, "second-attachments"),
			snapshotRoot: join(testDirectory, "second-snapshots"),
			workspaceRoot: process.cwd(),
		});
		const firstHost = await createSessionHost({
			capabilities: createCapabilities(),
			sessionId: seeded.sessionId,
		});

		try {
			await expect(
				createSessionHost({
					capabilities: createCapabilities(secondStore),
					sessionId: seeded.sessionId,
				})
			).rejects.toMatchObject({ code: "session_in_use" });
		} finally {
			await firstHost.shutdown();
			secondDatabase.sqlite.close();
		}
	});
});

describe("Session Host lifetime", () => {
	test("runs a send command, reports its events in order, and refuses commands after shutdown", async () => {
		const seeded = await seedSession("send");
		const capabilities = createCapabilities();
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		const events: AgentTurnEvent[] = [];
		host.onEvent((event) => events.push(event));
		let snapshotChanges = 0;
		host.subscribe(() => {
			snapshotChanges += 1;
		});

		const outcome = await host.agentSession.send(sendInput(capabilities));

		expect(outcome).toEqual({ rejected: false });
		expect(snapshotChanges).toBeGreaterThan(0);
		// The Agent Turn Events the Agent Session emits reach a consumer in order,
		// terminal event included.
		expect(events.map(({ type }) => type)).toEqual([
			"agent-turn-started",
			"model-step-started",
			"text-delta",
			"model-step-finished",
			"agent-turn-completed",
		]);
		const transcript = host.getSnapshot().transcript;
		expect(transcript.map(({ id }) => id)).toEqual(
			projectSessionRecords(
				await store.listSessionRecords(seeded.sessionId)
			).map(({ id }) => id)
		);
		const sentUserIndex = transcript.findIndex(
			({ parts, role }) => role === "user" && textOf(parts) === "third request"
		);
		const sentAssistantIndex = transcript.findIndex(
			({ parts, role }) =>
				role === "assistant" && textOf(parts) === "E2E chat response"
		);
		expect(sentUserIndex).toBeGreaterThanOrEqual(0);
		expect(sentAssistantIndex).toBeGreaterThan(sentUserIndex);

		await host.shutdown();

		// Shutdown rejects new work without publishing another Snapshot or
		// delivering an event to observers that are tearing down.
		const changesAtShutdown = snapshotChanges;
		const eventsAtShutdown = events.length;
		expect(await host.agentSession.send(sendInput(capabilities))).toMatchObject(
			{
				rejected: true,
			}
		);
		await expect(
			host.agentSession.compact({ model, trigger: "manual" })
		).rejects.toMatchObject({ code: "cancelled" });
		expect(snapshotChanges).toBe(changesAtShutdown);
		expect(events).toHaveLength(eventsAtShutdown);
	});
	test("reorders a streamed assistant message to its durable position after a steer", async () => {
		const { id: openedSessionId } = await store.createSession({
			agent: buildId,
			message: message(
				"live-transcript-order-initial",
				"user",
				"initial request"
			),
			model,
			turnId: agentTurnId("live-transcript-order-initial-turn"),
		});
		const capabilities = createCapabilities();
		const host = await createSessionHost({
			capabilities,
			sessionId: openedSessionId,
		});
		const assistantTextReachedSnapshot = Promise.withResolvers<void>();
		const releaseAssistantStream = Promise.withResolvers<void>();
		const completedTurn = Promise.withResolvers<void>();
		const previousAfterTextDelta = recorder.afterTextDelta;
		let activeTurnId: string | undefined;
		const unsubscribe = host.onEvent((event) => {
			if (
				event.type === "agent-turn-completed" &&
				event.turnId === activeTurnId
			) {
				completedTurn.resolve();
			}
		});
		recorder.afterTextDelta = async () => {
			assistantTextReachedSnapshot.resolve();
			await releaseAssistantStream.promise;
		};
		const inputFor = (userText: string): SessionSendInput => ({
			...sendInput(capabilities),
			composition: { files: [], text: userText },
			userText,
		});

		try {
			const active = await host.agentSession.prompt(
				inputFor("streamed answer before steer")
			);
			if (active.rejected || active.turnId === undefined) {
				throw new Error("The active Submission did not start.");
			}
			activeTurnId = active.turnId;
			await assistantTextReachedSnapshot.promise;

			const streamedAssistant = host
				.getSnapshot()
				.transcript.findLast(({ role }) => role === "assistant");
			if (streamedAssistant === undefined) {
				throw new Error("The streamed assistant message was not visible.");
			}
			expect(textOf(streamedAssistant.parts)).toBe("E2E chat response");

			const queued = await host.agentSession.prompt(
				inputFor("steer after streamed answer")
			);
			expect(queued).toMatchObject({
				disposition: "queued",
				rejected: false,
			});
			expect(
				host
					.getSnapshot()
					.transcript.some(
						({ parts, role }) =>
							role === "user" && textOf(parts) === "steer after streamed answer"
					)
			).toBe(false);
			const steering = await host.agentSession.steer();
			if (steering.kind !== "steered") {
				throw new Error("The queued Submission was not steered.");
			}

			const liveBeforeAssistantCommit = host.getSnapshot().transcript;
			const streamedAssistantIndex = liveBeforeAssistantCommit.findIndex(
				({ id }) => id === streamedAssistant.id
			);
			const steeringIndex = liveBeforeAssistantCommit.findIndex(
				({ id }) => id === steering.messageId
			);
			expect(streamedAssistantIndex).toBeGreaterThanOrEqual(0);
			expect(steeringIndex).toBeGreaterThan(streamedAssistantIndex);

			releaseAssistantStream.resolve();
			await completedTurn.promise;

			const storedTranscript = projectSessionRecords(
				await store.listSessionRecords(openedSessionId)
			);
			const liveMessageIds = host.getSnapshot().transcript.map(({ id }) => id);
			expect(liveMessageIds).toEqual(storedTranscript.map(({ id }) => id));
			expect(liveMessageIds.indexOf(steering.messageId)).toBeLessThan(
				liveMessageIds.indexOf(streamedAssistant.id)
			);
		} finally {
			releaseAssistantStream.resolve();
			recorder.afterTextDelta = previousAfterTextDelta;
			unsubscribe();
			await host.shutdown();
		}
	});
	test("removes streamed assistant content when its durable record cannot be saved", async () => {
		const { id: openedSessionId } = await store.createSession({
			agent: buildId,
			message: message(
				"failed-stream-order-initial",
				"user",
				"initial request"
			),
			model,
			turnId: agentTurnId("failed-stream-order-initial-turn"),
		});
		const failingStore: SessionStore = {
			...store,
			commitSessionRecord: async (input) => {
				if (input.record.outcome.kind === "assistant") {
					throw new Error("The assistant record could not be saved.");
				}
				await store.commitSessionRecord(input);
			},
		};
		const capabilities = createCapabilities(failingStore);
		const host = await createSessionHost({
			capabilities,
			sessionId: openedSessionId,
		});
		const assistantTextReachedSnapshot = Promise.withResolvers<void>();
		const releaseAssistantStream = Promise.withResolvers<void>();
		const errorPublished = Promise.withResolvers<void>();
		const previousAfterTextDelta = recorder.afterTextDelta;
		const unsubscribe = host.subscribe(() => {
			if (host.getSnapshot().error !== null) {
				errorPublished.resolve();
			}
		});
		recorder.afterTextDelta = async () => {
			assistantTextReachedSnapshot.resolve();
			await releaseAssistantStream.promise;
		};

		try {
			const admission = await host.agentSession.prompt({
				...sendInput(capabilities),
				composition: { files: [], text: "answer whose record fails" },
				userText: "answer whose record fails",
			});
			if (admission.rejected) {
				throw new Error(admission.reason);
			}
			await assistantTextReachedSnapshot.promise;
			expect(
				host
					.getSnapshot()
					.transcript.some(
						({ parts, role }) =>
							role === "assistant" &&
							textOf(parts).includes("E2E chat response")
					)
			).toBe(true);

			releaseAssistantStream.resolve();
			await errorPublished.promise;
			const snapshot = host.getSnapshot();
			expect(snapshot.error?.message).toBe(
				"The Agent Turn outcome could not be persisted."
			);
			expect(
				snapshot.transcript.some(
					({ parts, role }) =>
						role === "assistant" && textOf(parts).includes("E2E chat response")
				)
			).toBe(false);
		} finally {
			releaseAssistantStream.resolve();
			recorder.afterTextDelta = previousAfterTextDelta;
			unsubscribe();
			await host.shutdown();
		}
	});
	test("commits each queue-head steer before acknowledging and delivers four user messages FIFO", async () => {
		const seeded = await seedSession("durable-steer");
		const attachmentExternalizationStarted = Promise.withResolvers<void>();
		const releaseAttachmentExternalization = Promise.withResolvers<void>();
		const delayedAttachmentStore: SessionStore = {
			...store,
			externalizeAttachments: async (messages, signal, options) => {
				const hasQueuedImage = messages.some(({ parts }) =>
					parts.some(
						(part) =>
							part.type === "file" && part.filename === "queued-steer.png"
					)
				);
				if (hasQueuedImage) {
					attachmentExternalizationStarted.resolve();
					await releaseAttachmentExternalization.promise;
				}
				return await store.externalizeAttachments(messages, signal, options);
			},
		};
		const capabilities = createCapabilities(delayedAttachmentStore);
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		const queuedTexts = [
			"steer correction one",
			"steer correction two",
			"steer correction three",
			"steer correction four",
		];
		const activeStepStarted = Promise.withResolvers<void>();
		const releaseActiveStep = Promise.withResolvers<void>();
		const deliveredRequest = Promise.withResolvers<string[]>();
		const completedTurn = Promise.withResolvers<void>();
		const previousBeforeStep = recorder.beforeStep;
		let heldActiveStep = false;
		let activeTurnId: string | undefined;
		const submissionEvents: SessionSubmissionEvent[] = [];
		const unsubscribeSubmission = host.agentSession.onSubmissionEvent(
			(event) => {
				submissionEvents.push(event);
			}
		);
		const unsubscribe = host.onEvent((event) => {
			if (
				event.type === "agent-turn-completed" &&
				event.turnId === activeTurnId
			) {
				completedTurn.resolve();
			}
		});
		recorder.beforeStep = async ({ messages }) => {
			const userTexts = messages.flatMap(({ content, role }) =>
				role === "user"
					? content.flatMap((part) => (part.type === "text" ? [part.text] : []))
					: []
			);
			if (!heldActiveStep && userTexts.includes("durable active turn")) {
				heldActiveStep = true;
				activeStepStarted.resolve();
				await releaseActiveStep.promise;
				return;
			}
			if (queuedTexts.every((text) => userTexts.includes(text))) {
				deliveredRequest.resolve(
					userTexts.filter((text) => queuedTexts.includes(text))
				);
			}
		};
		const inputFor = (
			userText: string,
			files: readonly SessionFilePart[] = []
		): SessionSendInput => ({
			...sendInput(capabilities),
			composition: { files: [...files], text: userText },
			files: [...files],
			userText,
		});
		const queuedImage: SessionFilePart = {
			filename: "queued-steer.png",
			mediaType: "image/png",
			type: "file",
			url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=",
		};

		try {
			const active = await host.agentSession.prompt(
				inputFor("durable active turn")
			);
			if (active.rejected || active.turnId === undefined) {
				throw new Error("The active Submission did not start.");
			}
			activeTurnId = active.turnId;
			await activeStepStarted.promise;

			const admissions: Array<{
				admission: Extract<
					SessionSubmissionAdmission,
					{ readonly rejected: false }
				>;
				userText: string;
			}> = [];
			for (const userText of queuedTexts) {
				const files = userText === queuedTexts[0] ? [queuedImage] : [];
				const admission = await host.agentSession.prompt(
					inputFor(userText, files)
				);
				if (admission.rejected) {
					throw new Error(admission.reason);
				}
				admissions.push({ admission, userText });
			}
			expect(
				host
					.getSnapshot()
					.transcript.some(({ id }) =>
						admissions.some(({ admission }) => admission.messageId === id)
					)
			).toBe(false);

			const firstAdmission = admissions[0];
			if (firstAdmission === undefined) {
				throw new Error("The first queued Submission was not accepted.");
			}
			const firstSteering = host.agentSession.steer();
			await attachmentExternalizationStarted.promise;
			expect(
				host
					.getSnapshot()
					.queuedSubmissions.map(({ input }) => input.composition.text)
			).toEqual(queuedTexts);
			expect(
				(await store.listSessionRecords(seeded.sessionId)).some((record) =>
					record.messages.some(
						({ id }) => id === firstAdmission.admission.messageId
					)
				)
			).toBe(false);
			releaseAttachmentExternalization.resolve();

			const assertSteered = async (
				queued: (typeof admissions)[number],
				outcome: SessionSteeringAdmission
			): Promise<void> => {
				const { admission, userText } = queued;
				if (outcome.kind !== "steered") {
					throw new Error(
						`The queued Submission was not steered: ${JSON.stringify(outcome)}`
					);
				}
				expect(outcome).toMatchObject({
					kind: "steered",
					messageId: admission.messageId,
					submissionId: admission.submissionId,
					turnId: active.turnId,
				});
				const message = host
					.getSnapshot()
					.transcript.find(({ id }) => id === admission.messageId);
				if (message === undefined) {
					throw new Error(
						"The committed Submission was not in the transcript."
					);
				}
				expect(textOf(message.parts)).toBe(userText);
				const matchingRecords = (
					await store.listSessionRecords(seeded.sessionId)
				).filter((record) =>
					record.messages.some(({ id }) => id === admission.messageId)
				);
				expect(matchingRecords).toHaveLength(1);
				expect(matchingRecords[0]?.outcome.kind).toBe("user");
				expect(matchingRecords[0]?.messages[0]?.id).toBe(admission.messageId);
				expect(matchingRecords[0]?.messages[0]?.metadata?.submissionId).toBe(
					admission.submissionId
				);
				expect(
					matchingRecords[0]?.messages[0]?.metadata?.submissionStatus
				).toBe("pending");
				expect(
					await host.agentSession.recallWaitingMessages([
						admission.submissionId,
					])
				).toEqual([]);
			};
			await assertSteered(firstAdmission, await firstSteering);
			for (const queued of admissions.slice(1)) {
				await assertSteered(queued, await host.agentSession.steer());
			}

			const transcriptBeforeEmptySteer = host.getSnapshot().transcript;
			const recordsBeforeEmptySteer = await store.listSessionRecords(
				seeded.sessionId
			);
			expect(await host.agentSession.steer()).toEqual({ kind: "empty" });
			expect(host.getSnapshot().transcript).toEqual(transcriptBeforeEmptySteer);
			expect(await store.listSessionRecords(seeded.sessionId)).toEqual(
				recordsBeforeEmptySteer
			);

			releaseActiveStep.resolve();
			expect(await deliveredRequest.promise).toEqual(queuedTexts);
			await completedTurn.promise;
			const completedRecords = await store.listSessionRecords(seeded.sessionId);
			for (const { admission } of admissions) {
				const record = completedRecords.find((candidate) =>
					candidate.messages.some(({ id }) => id === admission.messageId)
				);
				expect(record?.messages[0]?.metadata?.submissionStatus).toBe(
					"processed"
				);
				expect(
					submissionEvents
						.filter((event) => event.messageId === admission.messageId)
						.map(({ kind }) => kind)
				).toEqual(["steered", "delivered", "processed"]);
			}
			expect(host.getSnapshot().steeringMessages).toEqual([]);
		} finally {
			releaseActiveStep.resolve();
			releaseAttachmentExternalization.resolve();
			recorder.beforeStep = previousBeforeStep;
			unsubscribe();
			unsubscribeSubmission();
			await host.shutdown();
		}
	});
	test("reconciles an unconfirmed processing submission as a retry blocker after restart", async () => {
		const seeded = await seedSession("steer-restart");
		const capabilities = createCapabilities();
		let host: SessionHost = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		const activeStepStarted = Promise.withResolvers<void>();
		const releaseActiveStep = Promise.withResolvers<void>();
		const previousBeforeStep = recorder.beforeStep;
		let heldActiveStep = false;
		recorder.beforeStep = async ({ messages }) => {
			const hasActivePrompt = messages.some(
				({ content, role }) =>
					role === "user" &&
					content.some(
						(part) =>
							part.type === "text" && part.text === "restart active turn"
					)
			);
			if (!heldActiveStep && hasActivePrompt) {
				heldActiveStep = true;
				activeStepStarted.resolve();
				await releaseActiveStep.promise;
			}
		};
		try {
			const active = await host.agentSession.prompt({
				...sendInput(capabilities),
				composition: { files: [], text: "restart active turn" },
				userText: "restart active turn",
			});
			if (active.rejected) {
				throw new Error(active.reason);
			}
			await activeStepStarted.promise;
			const queued = await host.agentSession.prompt({
				...sendInput(capabilities),
				composition: { files: [], text: "accepted before restart" },
				userText: "accepted before restart",
			});
			if (queued.rejected) {
				throw new Error(queued.reason);
			}
			const steered = await host.agentSession.steer();
			if (steered.kind !== "steered") {
				throw new Error("The queued Submission was not committed.");
			}
			const record = (await store.listSessionRecords(seeded.sessionId)).find(
				(candidate) =>
					candidate.messages.some(({ id }) => id === steered.messageId)
			);
			if (record === undefined) {
				throw new Error("The committed Submission Record is unavailable.");
			}
			await store.updateSessionSubmission({
				messageId: steered.messageId,
				recordId: record.id,
				sessionId: seeded.sessionId,
				status: "processing",
				submissionId: steered.submissionId,
			});
			host.agentSession.cancel();
			releaseActiveStep.resolve();
			await host.shutdown();
			const callsBeforeReopen = recorder.requests.length;
			host = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});

			const snapshot = host.getSnapshot();
			expect(snapshot.steeringMessages).toMatchObject([
				{
					message: {
						id: steered.messageId,
						metadata: {
							submissionFailure:
								"Session closed before provider processing could be confirmed; deliberate retry required.",
							submissionStatus: "failed",
						},
					},
					status: "failed",
				},
			]);
			expect(snapshot.context.some(({ id }) => id === steered.messageId)).toBe(
				false
			);
			expect(host.agentSession.continue()).toMatchObject({
				kind: "rejected",
			});
			expect(recorder.requests).toHaveLength(callsBeforeReopen);
			const recoveredRecord = (
				await store.listSessionRecords(seeded.sessionId)
			).find((candidate) =>
				candidate.messages.some(({ id }) => id === steered.messageId)
			);
			expect(recoveredRecord?.messages[0]?.metadata?.submissionStatus).toBe(
				"failed"
			);
		} finally {
			releaseActiveStep.resolve();
			recorder.beforeStep = previousBeforeStep;
			await host.shutdown();
		}
	});

	test("resumes an unread durable Submission once after restart", async () => {
		const seeded = await seedSession("steer-unread-restart");
		const capabilities = createCapabilities();
		let host: SessionHost = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		const activeStepStarted = Promise.withResolvers<void>();
		const releaseActiveStep = Promise.withResolvers<void>();
		const resumedStepStarted = Promise.withResolvers<void>();
		const releaseResumedStep = Promise.withResolvers<void>();
		const processed = Promise.withResolvers<void>();
		const previousBeforeStep = recorder.beforeStep;
		let heldActiveStep = false;
		const resumedRequests: string[][] = [];
		const submissionEvents: SessionSubmissionEvent[] = [];
		let unsubscribeResumed: () => void = () => undefined;
		const unsubscribeInitial = host.agentSession.onSubmissionEvent((event) => {
			submissionEvents.push(event);
		});
		const inputFor = (userText: string): SessionSendInput => ({
			...sendInput(capabilities),
			composition: { files: [], text: userText },
			userText,
		});
		recorder.beforeStep = async ({ messages }) => {
			const userTexts = messages.flatMap(({ content, role }) =>
				role === "user"
					? content.flatMap((part) => (part.type === "text" ? [part.text] : []))
					: []
			);
			if (!heldActiveStep && userTexts.includes("restart pending active")) {
				heldActiveStep = true;
				activeStepStarted.resolve();
				await releaseActiveStep.promise;
				return;
			}
			if (userTexts.includes("accepted before restart")) {
				resumedRequests.push(
					userTexts.filter((text) => text === "accepted before restart")
				);
				resumedStepStarted.resolve();
				await releaseResumedStep.promise;
			}
		};

		try {
			const active = await host.agentSession.prompt(
				inputFor("restart pending active")
			);
			if (active.rejected) {
				throw new Error(active.reason);
			}
			await activeStepStarted.promise;
			const admission = await host.agentSession.prompt(
				inputFor("accepted before restart")
			);
			if (admission.rejected) {
				throw new Error(admission.reason);
			}
			const steered = await host.agentSession.steer();
			if (steered.kind !== "steered") {
				throw new Error("The queued Submission was not committed.");
			}

			host.agentSession.cancel();
			releaseActiveStep.resolve();
			await host.shutdown();
			const interruptedRecord = (
				await store.listSessionRecords(seeded.sessionId)
			).find((record) =>
				record.messages.some(({ id }) => id === steered.messageId)
			);
			expect(interruptedRecord?.messages[0]?.metadata?.submissionStatus).toBe(
				"pending"
			);

			host = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});
			unsubscribeResumed = host.agentSession.onSubmissionEvent((event) => {
				submissionEvents.push(event);
				if (
					event.kind === "processed" &&
					event.submissionId === steered.submissionId
				) {
					processed.resolve();
				}
			});
			await resumedStepStarted.promise;
			releaseResumedStep.resolve();
			await processed.promise;

			expect(resumedRequests).toEqual([["accepted before restart"]]);
			const matchingRecords = (
				await store.listSessionRecords(seeded.sessionId)
			).filter((record) =>
				record.messages.some(({ id }) => id === steered.messageId)
			);
			expect(matchingRecords).toHaveLength(1);
			expect(matchingRecords[0]?.messages[0]?.metadata?.submissionStatus).toBe(
				"processed"
			);
			expect(
				host
					.getSnapshot()
					.transcript.filter(({ id }) => id === steered.messageId)
			).toHaveLength(1);
			expect(
				submissionEvents
					.filter(({ submissionId }) => submissionId === steered.submissionId)
					.map(({ kind }) => kind)
			).toEqual(["steered", "started", "processed"]);
		} finally {
			releaseActiveStep.resolve();
			releaseResumedStep.resolve();
			recorder.beforeStep = previousBeforeStep;
			unsubscribeInitial();
			unsubscribeResumed();
			await host.shutdown();
		}
	});

	test("debug diagnostics mark host and turn lifecycle without session content", async () => {
		const seeded = await seedSession("debug-lifecycle");
		const capabilities = createCapabilities();
		await withLoggerHome(async () => {
			await withDebugProject(testDirectory, async () => {
				const host = await createSessionHost({
					capabilities,
					sessionId: seeded.sessionId,
				});
				try {
					expect(await host.agentSession.send(sendInput(capabilities))).toEqual(
						{ rejected: false }
					);
				} finally {
					await host.shutdown();
				}

				await logger.flush();
				const records = await readLoggerRecords(testDirectory);
				const debugRecords = records.filter(({ level }) => level === "debug");
				for (const phase of ["opened", "shutdown", "shutdown-completed"]) {
					expect(debugRecords).toContainEqual(
						expect.objectContaining({
							context: expect.objectContaining({
								operation: "session-host",
								phase,
							}),
						})
					);
				}
				for (const phase of ["started", "completed"]) {
					expect(debugRecords).toContainEqual(
						expect.objectContaining({
							context: expect.objectContaining({
								operation: "session.turn",
								phase,
								turnId: expect.any(String),
							}),
						})
					);
				}
				expect(JSON.stringify(debugRecords)).not.toContain("third request");
			});
		});
	});

	test("refuses a competing Session Writer until its delayed checkpoint settles", async () => {
		const seeded = await seedSession("shutdown-quiescence");
		const delayed = createDelayedTerminalStore(store);
		const capabilities = createCapabilities(delayed.delayed);
		const competingDatabase = createDatabase(
			join(testDirectory, "sessions.db")
		);
		const competingStore = createDrizzleSessionStore(competingDatabase.db, {
			attachmentRoot: join(testDirectory, "competing-attachments"),
			workspaceRoot: process.cwd(),
		});
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		let competingWriter: SessionWriterLock | undefined;

		try {
			const send = host.agentSession.send(sendInput(capabilities));
			await delayed.terminalCommitStarted.promise;
			// Advance any shutdown deadline deterministically before checking ownership.
			vi.useFakeTimers();
			let shutdown: Promise<void> | undefined;
			let shutdownTimers = 0;
			try {
				shutdown = host.shutdown();
				shutdownTimers = vi.getTimerCount();
				vi.advanceTimersByTime(60_000);
			} finally {
				vi.useRealTimers();
			}
			if (shutdownTimers > 0 && shutdown !== undefined) {
				await shutdown;
			}
			expect(host.getSnapshot().turnActive).toBe(true);
			await expect(
				competingStore.acquireSessionWriter(seeded.sessionId)
			).rejects.toMatchObject({ code: "session_in_use" });
			delayed.allowTerminalCommit.resolve();
			await shutdown;
			await send;
			const finalRecord = (await store.listSessionRecords(seeded.sessionId)).at(
				-1
			);
			expect(finalRecord?.outcome).toMatchObject({
				kind: "assistant",
				terminal: { kind: "completed" },
			});
			competingWriter = await competingStore.acquireSessionWriter(
				seeded.sessionId
			);
		} finally {
			delayed.allowTerminalCommit.resolve();
			await host.shutdown();
			await competingWriter?.release();
			competingDatabase.sqlite.close();
		}
	}, 15_000);

	test("waits for same-process Host shutdown before remounting", async () => {
		const seeded = await seedSession("shutdown-remount");
		const delayed = createDelayedTerminalStore(store);
		const host = await createSessionHost({
			capabilities: createCapabilities(delayed.delayed),
			sessionId: seeded.sessionId,
		});
		const send = host.agentSession.send(
			sendInput(createCapabilities(delayed.delayed))
		);
		await delayed.terminalCommitStarted.promise;
		const shutdown = host.shutdown();
		const remount = createSessionHost({
			capabilities: createCapabilities(),
			sessionId: seeded.sessionId,
		});
		const probe = Promise.withResolvers<"probe">();
		queueMicrotask(() => probe.resolve("probe"));
		expect(
			await Promise.race([
				remount.then(() => "remounted" as const),
				probe.promise,
			])
		).toBe("probe");

		delayed.allowTerminalCommit.resolve();
		await shutdown;
		await send;
		const remountedHost = await remount;
		await remountedHost.shutdown();
	});

	test("logs prompt persistence failures without prompt or exception content", async () => {
		await withLoggerHome(async (home) => {
			const seeded = await seedSession("prompt-persistence");
			const turnId = agentTurnId("prompt-persistence-turn");
			const failureMessage = "private database detail";
			const failingStore: SessionStore = {
				...store,
				commitSessionRecord: async () => {
					throw Object.assign(new Error(failureMessage), { code: "EIO" });
				},
			};
			const capabilities = createCapabilities(failingStore);
			const host = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});

			try {
				expect(
					await host.agentSession.send({ ...sendInput(capabilities), turnId })
				).toMatchObject({ rejected: true });
			} finally {
				await host.shutdown();
			}

			await logger.flush();
			const records = await readLoggerRecords(home);
			const persistenceRecords = records.filter(
				({ message }) => message === "Session prompt persistence failed"
			);
			expect(persistenceRecords).toHaveLength(1);
			expect(persistenceRecords[0]).toMatchObject({
				context: {
					errorCode: "EIO",
					errorType: "Error",
					operation: "session.prompt",
					phase: "persistence",
					turnId,
				},
				level: "error",
			});
			expect(JSON.stringify(persistenceRecords[0])).not.toContain(
				failureMessage
			);
			expect(JSON.stringify(persistenceRecords[0])).not.toContain(
				"third request"
			);
			expect(JSON.stringify(persistenceRecords[0])).not.toContain(
				seeded.sessionId
			);
		});
	});
	test("records background compaction failures without failing the completed turn", async () => {
		const seeded = await seedSession("background-compaction");
		const modelRequestsBeforeTurn = recorder.requests.length;
		const summaryStarted = Promise.withResolvers<void>();
		const allowSummaryFailure = Promise.withResolvers<void>();
		const compactionFailureObserved = Promise.withResolvers<void>();
		const capabilities: SessionCapabilities = {
			...createCapabilities(),
			getCompactionModule: () =>
				compactionModule(async () => {
					summaryStarted.resolve();
					await allowSummaryFailure.promise;
					throw Object.assign(new Error("private summary detail"), {
						code: "SUMMARY_FAILED",
					});
				}),
			getCompactionSettings: async () =>
				fromPartial<ResolvedCompactionSettings>({
					autoAvailable: recorder.requests.length > modelRequestsBeforeTurn,
					enabled: true,
					thresholdTokens: 1,
				}),
		};
		await withLoggerHome(async (home) => {
			const host = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});
			const unsubscribe = host.subscribe(() => {
				if (host.getSnapshot().compactionError !== null) {
					compactionFailureObserved.resolve();
				}
			});
			try {
				expect(await host.agentSession.send(sendInput(capabilities))).toEqual({
					rejected: false,
				});
				await summaryStarted.promise;
				allowSummaryFailure.resolve();
				await compactionFailureObserved.promise;
			} finally {
				allowSummaryFailure.resolve();
				unsubscribe();
				await host.shutdown();
			}

			await logger.flush();
			const records = await readLoggerRecords(home);
			const compactionRecords = records.filter(
				({ context }) =>
					context?.operation === "session.compaction" &&
					context?.trigger === "threshold"
			);
			expect(compactionRecords).toHaveLength(1);
			expect(compactionRecords[0]).toMatchObject({
				context: {
					errorCode: "summary-failed",
					errorType: "SessionCompactionError",
					phase: "failed",
					trigger: "threshold",
					turnId: expect.any(String),
				},
				level: "warn",
			});
			expect(JSON.stringify(compactionRecords[0])).not.toContain(
				"private summary detail"
			);
			expect(JSON.stringify(compactionRecords[0])).not.toContain(
				"third request"
			);
		});
	});
	test("does not warn for shutdown-cancelled background compaction", async () => {
		const seeded = await seedSession("cancelled-background-compaction");
		const modelRequestsBeforeTurn = recorder.requests.length;
		const capabilities: SessionCapabilities = {
			...createCapabilities(),
			getCompactionModule: () =>
				compactionModule(async () => {
					throw Object.assign(new Error("private summary detail"), {
						code: "SUMMARY_FAILED",
					});
				}),
			getCompactionSettings: async () =>
				fromPartial<ResolvedCompactionSettings>({
					autoAvailable: recorder.requests.length > modelRequestsBeforeTurn,
					enabled: true,
					thresholdTokens: 1,
				}),
		};
		await withLoggerHome(async (home) => {
			const host = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});
			expect(await host.agentSession.send(sendInput(capabilities))).toEqual({
				rejected: false,
			});
			await host.shutdown();

			await logger.flush();
			const records = await readLoggerRecords(home).catch(() => []);
			expect(
				records.filter(
					({ context }) =>
						context?.operation === "session.compaction" &&
						context?.trigger === "threshold"
				)
			).toEqual([]);
		});
	});

	test("releases a completed idle Session writer after its last view", async () => {
		const seeded = await seedSession("idle-view-release");
		const manager = createSessionHostManager();
		const capabilities = createCapabilities(store, {}, manager);
		try {
			const host = await manager.openHost({
				capabilities,
				sessionId: seeded.sessionId,
				view: true,
			});
			await host.agentSession.send(
				sendInput(capabilities, "complete before release")
			);
			await manager.releaseView(seeded.sessionId);
			const writer = await store.acquireSessionWriter(seeded.sessionId);
			await writer.release();
		} finally {
			await manager.shutdownAll();
		}
	});
});
