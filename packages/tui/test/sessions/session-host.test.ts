import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The Host opens the store its capabilities hand it, so this test runs against
 * a real local store of its own: a temporary directory nothing else in the
 * process shares.
 */
const testDirectory = mkdtempSync(join(tmpdir(), "wincode-session-host-"));

import { fromPartial } from "@total-typescript/shoehorn";
import {
	type AgentTurnEvent,
	createOperationalFailure,
	type SessionMessageId,
	type SessionRecord,
} from "@wincode/agent-core";
import type { ChatModelSelection } from "@wincode/ai/models";
import type { ResolvedCodingAgent } from "@/modules/agents/built-ins";
import { buildAgentRegistry } from "@/modules/agents/registry";
import { createSessionCompaction } from "@/modules/sessions/compaction/compaction";
import type { ResolvedCompactionSettings } from "@/modules/sessions/compaction/config";
import { compactionSummaryMessageId } from "@/modules/sessions/compaction/summary-message";
import type {
	AppendSessionCompactionInput,
	SummaryGenerator,
} from "@/modules/sessions/compaction/types";
import type {
	SessionCapabilities,
	SessionHostFailure,
} from "@/modules/sessions/host/types";
import type { SessionMessage } from "@/modules/sessions/message";
import type { SessionSendInput } from "@/modules/sessions/session-operation";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import { createConfigStore } from "@/shared/config/config-store";
import type { CompactionId, SessionId } from "@/shared/identifiers";
import { toMcpSnapshotId } from "@/shared/identifiers";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import {
	createFakeAiSdkModule,
	createFakeAiSdkRecorder,
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

const recorder = createFakeAiSdkRecorder();
// The module mock must be installed before the production Session Host graph
// loads, so the Agent Runtime the Host composes is the fake one. The production
// modules are imported dynamically for that reason alone.
await mock.module("@wincode/agent-runtime-ai-sdk", () =>
	createFakeAiSdkModule(recorder)
);

const { createSessionHost } = await import(
	"@/modules/sessions/host/session-host"
);
const { createDatabase } = await import("@/modules/sessions/storage/client");
const { createDrizzleSessionStore } = await import(
	"@/modules/sessions/storage/drizzle-session-store"
);
const { buildUserSessionRecord } = await import(
	"@/modules/sessions/storage/session-record"
);
const { createPermissionService } = await import(
	"@/modules/permissions/permission-service"
);
const { createToolPermissionPolicyState, createToolPermissionRuntime } =
	await import("@/modules/permissions/tool-permission-runtime");

const model: ChatModelSelection = {
	modelId: modelId("gpt-5.6-luna"),
	providerId: "openai",
};
const buildId = agentId("build");
const parentTurnId = agentTurnId("turn-parent");
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
 * Seeds one session whose durable records exercise what opening must project:
 * a completed turn, an interrupted turn, a delegated Subagent row, and a
 * compaction whose boundary sits between them.
 */
const seedSession = async (
	prefix: string
): Promise<{
	compaction: CompactionId;
	delegatedMessageId: SessionMessageId;
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
					parts: [{ text: "half an answer", type: "text" }],
					role: "assistant",
				},
			],
			model,
			outcome: {
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
	await store.commitSessionRecord({
		record: {
			agentId: buildId,
			delegation: { parentToolCallId: toolCallId("call-1"), parentTurnId },
			id: sessionRecordId(`${prefix}-record-4`),
			messages: [
				{
					id: sessionMessageId(`${prefix}-assistant-delegated`),
					parts: [{ text: "delegated answer", type: "text" }],
					role: "assistant",
				},
			],
			model,
			outcome: completedOutcome(),
			turnId: agentTurnId(`${prefix}-turn-child`),
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
		delegatedMessageId: sessionMessageId(
			`delegated-turn:${prefix}-turn-child:0:${sessionMessageId(`${prefix}-assistant-delegated`)}`
		),
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
 * Compaction module the engine suite fakes the same way.
 */
const createCapabilities = (
	sessionStore: SessionStore = store
): SessionCapabilities => {
	const workspace = process.cwd();
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: {},
			sourceFor: () => undefined,
			sources: [],
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
		homeRoot: homedir(),
		workspace,
	};
	const toolPermission = createToolPermissionRuntime({
		agent: buildId,
		policyState: createToolPermissionPolicyState(),
		registry,
		service: createPermissionService(),
		workspace,
	});
	return {
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
		getMcp: () => ({
			createSnapshot: async (agent) => ({
				agent,
				id: toMcpSnapshotId("session-host"),
				manifest: [],
				tools: new Map(),
			}),
		}),
		getRegistry: () => registry,
		getStore: () => sessionStore,
		getToolPermission: () => toolPermission,
	};
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

const sendInput = (capabilities: SessionCapabilities): SessionSendInput => ({
	agent: buildId,
	composition: { files: [], text: "third request" },
	model,
	resolvedAgent: resolvedAgentOf(capabilities),
	sessionModel: model,
	userText: "third request",
});

const approvalRequest: ToolApprovalRequest = {
	description: "Run a shell command",
	identity: [{ label: "tool", value: "shell" }],
	input: { command: "ls" },
};

const textOf = (parts: SessionMessage["parts"]): string =>
	parts.map((part) => (part.type === "text" ? part.text : "")).join("");

afterAll(() => {
	rmSync(testDirectory, { force: true, recursive: true });
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
			seeded.delegatedMessageId,
		]);
		// An interrupted turn keeps its Session Record and reads as interrupted.
		expect(snapshot.transcript[3]?.metadata?.terminalOutcome).toBe(
			"interrupted"
		);
		// The Session Context is rebuilt around the latest compaction — the
		// summary stands in for the messages it covers — and leaves the
		// delegated Subagent row out of what the model is sent.
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
			variant: undefined,
		});

		host.shutdown();
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
			firstHost.shutdown();
			secondDatabase.sqlite.close();
		}
	});
});

describe("Session Host lifetime", () => {
	test("runs a send command, reports its events in order, and refuses sends after shutdown", async () => {
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

		const outcome = await host.engine.send(sendInput(capabilities));

		expect(outcome).toEqual({ rejected: false });
		expect(snapshotChanges).toBeGreaterThan(0);
		// The Agent Turn Events the Engine receives reach a consumer in order,
		// terminal event included.
		expect(events.map(({ type }) => type)).toEqual([
			"agent-turn-started",
			"model-step-started",
			"text-delta",
			"model-step-finished",
			"agent-turn-completed",
		]);
		const sent = host.getSnapshot().transcript.slice(-2);
		expect(sent.map(({ role }) => role)).toEqual(["user", "assistant"]);
		expect(textOf(sent[0]?.parts ?? [])).toBe("third request");
		expect(textOf(sent[1]?.parts ?? [])).toBe("E2E chat response");

		host.shutdown();

		// Shutdown ends the session: nothing keeps running, the send that
		// arrives after it is refused instead of being queued, and neither
		// channel reaches its observer once the consumer is tearing down.
		const changesAtShutdown = snapshotChanges;
		const eventsAtShutdown = events.length;
		// A context swap still publishes inside the Engine, so it is what proves
		// the subscription is over rather than merely quiet.
		host.engine.applyContext([
			message("after-shutdown", "user", "after shutdown"),
		]);
		expect(await host.engine.send(sendInput(capabilities))).toMatchObject({
			rejected: true,
		});
		expect(snapshotChanges).toBe(changesAtShutdown);
		expect(events).toHaveLength(eventsAtShutdown);
	});

	test("settles an approval a consumer is waiting on when the session shuts down", async () => {
		const seeded = await seedSession("approval");
		const capabilities = createCapabilities();
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		const settlement = host.engine.requestApproval(approvalRequest);

		host.shutdown();

		expect(await settlement).toEqual({ decision: "reject" });
	});
	test("reports lease loss and closes the Host without releasing a takeover", async () => {
		const seeded = await seedSession("lease-loss");
		const takeoverDatabase = createDatabase(join(testDirectory, "sessions.db"));
		const takeoverStore = createDrizzleSessionStore(takeoverDatabase.db, {
			attachmentRoot: join(testDirectory, "takeover-attachments"),
			snapshotRoot: join(testDirectory, "takeover-snapshots"),
			workspaceRoot: process.cwd(),
		});
		const now = { value: 1000 };
		const ticks = new Set<() => void>();
		const capabilities = createCapabilities();
		const host = await createSessionHost({
			capabilities,
			lease: {
				now: () => now.value,
				schedule: (callback) => {
					ticks.add(callback);
					return () => ticks.delete(callback);
				},
			},
			sessionId: seeded.sessionId,
		});
		const failures: SessionHostFailure[] = [];
		host.onFatal((next) => {
			failures.push(next);
		});
		const approval = host.engine.requestApproval(approvalRequest);

		try {
			now.value = 31_001;
			const takeover = await takeoverStore.acquireSessionLease(
				seeded.sessionId,
				{ now: () => now.value }
			);
			for (const tick of ticks) {
				tick();
			}

			expect(failures).toEqual([{ code: "session_lease_lost" }]);
			expect(await approval).toEqual({ decision: "reject" });
			expect(await host.engine.send(sendInput(capabilities))).toMatchObject({
				rejected: true,
			});
			await expect(
				takeoverStore.acquireSessionLease(seeded.sessionId, {
					now: () => now.value,
				})
			).rejects.toMatchObject({ code: "session_in_use" });
			takeover.release();
			host.shutdown();
		} finally {
			takeoverDatabase.sqlite.close();
		}
	});
});
