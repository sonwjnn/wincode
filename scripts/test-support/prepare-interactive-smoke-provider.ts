import * as path from "node:path";
import {
	SESSION_RECORD_VERSION,
	type SessionRecord,
} from "../../packages/agent-core/src/records";
import { pluginSourceIdentity } from "../../packages/coding-agent/modules/plugins/loader";
import type { ProviderModelSelection } from "../../packages/coding-agent/modules/providers/provider-model-selection";
import {
	createProviderSdkCredentialStore,
	pluginProviderStorageId,
} from "../../packages/coding-agent/modules/providers/provider-stores";
import { createSessionUserMessage } from "../../packages/coding-agent/modules/sessions/message";
import { buildUserSessionRecord } from "../../packages/coding-agent/modules/sessions/storage/session-record";
import { resolveUserDataDir } from "../../packages/coding-agent/shared/paths/user-data-dir";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionMessageId,
	sessionRecordId,
} from "../../packages/coding-agent/test/support/identifiers";
import { openInteractiveSmokeSessionStore } from "./interactive-smoke-session-store";

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const pluginPath = path.join(
	repositoryRoot,
	"packages/coding-agent/test/support/interactive-smoke-provider.ts"
);
const storageId = pluginProviderStorageId({
	pluginId: "interactive_smoke",
	providerId: "terminal-smoke",
	sourceIdentity: pluginSourceIdentity(pluginPath),
});
const credentialStore = createProviderSdkCredentialStore({
	userDataDir: resolveUserDataDir(),
});

await credentialStore.modify(storageId, () => ({ kind: "local-test" }));

if (process.env.WINCODE_SMOKE_INVALID_ENDPOINT === "1") {
	const providerModel: ProviderModelSelection = {
		modelId: modelId("fake"),
		pluginProviderSource: {
			pluginId: "interactive_smoke",
			sourceIdentity: pluginSourceIdentity(pluginPath),
		},
		providerId: "terminal-smoke",
	};
	const smokeAgent = agentId("terminal-smoke");
	const workspaceRoot = process.env.WINCODE_SMOKE_WORKSPACE;
	if (workspaceRoot === undefined) {
		throw new Error("WINCODE_SMOKE_WORKSPACE is required for session seeding.");
	}
	const { close, store } = openInteractiveSmokeSessionStore(workspaceRoot);
	try {
		const { id: sessionId, writeOutcome: creation } =
			await store.createEmptySession({ model: providerModel });
		if (creation.kind !== "committed") {
			throw new Error("Could not create the invalid-endpoint smoke Session.");
		}
		const userMessage = createSessionUserMessage(
			"invalid endpoint smoke seed",
			{ agent: smokeAgent, model: providerModel }
		);
		const userRecord = buildUserSessionRecord({
			agentId: smokeAgent,
			message: userMessage,
			model: providerModel,
			turnId: agentTurnId("smoke-invalid-endpoint-turn"),
		});
		const userWrite = await store.commitSessionRecord({
			record: userRecord,
			sessionId,
		});
		if (userWrite.kind !== "committed") {
			throw new Error("Could not write the invalid-endpoint smoke prompt.");
		}
		const checkpointRecord: SessionRecord = {
			agentId: smokeAgent,
			id: sessionRecordId("smoke-invalid-endpoint-checkpoint"),
			messages: [
				{
					id: sessionMessageId("smoke-invalid-endpoint-checkpoint-message"),
					metadata: {
						agent: smokeAgent,
						model: providerModel,
						sourceUserMessageId: userMessage.id,
					},
					parts: [{ text: "non-terminal assistant checkpoint", type: "text" }],
					role: "assistant",
				},
			],
			model: providerModel,
			outcome: { kind: "checkpoint" },
			turnId: agentTurnId("smoke-invalid-endpoint-turn"),
			version: SESSION_RECORD_VERSION,
		};
		const checkpointWrite = await store.commitSessionRecord({
			record: checkpointRecord,
			sessionId,
		});
		if (checkpointWrite.kind !== "committed") {
			throw new Error("Could not write the non-terminal smoke checkpoint.");
		}
		await store.updateSession(sessionId, {
			title: "Invalid endpoint smoke fixture",
		});
	} finally {
		close();
	}
}

if (process.env.WINCODE_SMOKE_BRANCH_EXPORT === "1") {
	const providerModel: ProviderModelSelection = {
		modelId: modelId("fake"),
		pluginProviderSource: {
			pluginId: "interactive_smoke",
			sourceIdentity: pluginSourceIdentity(pluginPath),
		},
		providerId: "terminal-smoke",
	};
	const smokeAgent = agentId("terminal-smoke");
	const workspaceRoot = process.env.WINCODE_SMOKE_WORKSPACE;
	if (workspaceRoot === undefined) {
		throw new Error("WINCODE_SMOKE_WORKSPACE is required for session seeding.");
	}
	const { close, store } = openInteractiveSmokeSessionStore(workspaceRoot);
	try {
		const { id: sessionId, writeOutcome: creation } =
			await store.createEmptySession({ model: providerModel });
		if (creation.kind !== "committed") {
			throw new Error("Could not create the branch-export smoke Session.");
		}
		const rootMessage = createSessionUserMessage("branch smoke shared root", {
			agent: smokeAgent,
			model: providerModel,
		});
		const rootRecord = buildUserSessionRecord({
			agentId: smokeAgent,
			message: rootMessage,
			model: providerModel,
			turnId: agentTurnId("smoke-branch-export-turn"),
		});
		const rootWrite = await store.commitSessionRecord({
			record: rootRecord,
			sessionId,
		});
		if (rootWrite.kind !== "committed") {
			throw new Error("Could not write the branch-export smoke root.");
		}
		const createAssistantRecord = (
			id: string,
			text: string,
			usage: Readonly<{ inputTokens: number; outputTokens: number }>
		): SessionRecord => ({
			agentId: smokeAgent,
			id: sessionRecordId(id),
			messages: [
				{
					id: sessionMessageId(`${id}-message`),
					metadata: { model: providerModel, usage },
					parts: [{ text, type: "text" }],
					role: "assistant",
				},
			],
			model: providerModel,
			outcome: {
				kind: "assistant",
				terminal: {
					finishedAt: 1_800_000_000_000,
					kind: "completed",
					usage,
				},
			},
			turnId: rootRecord.turnId,
			version: SESSION_RECORD_VERSION,
		});
		const siblingRecord = createAssistantRecord(
			"smoke-branch-export-sibling",
			"branch smoke sibling answer",
			{ inputTokens: 7, outputTokens: 2 }
		);
		const siblingWrite = await store.commitSessionRecord({
			record: siblingRecord,
			sessionId,
		});
		if (siblingWrite.kind !== "committed") {
			throw new Error("Could not write the branch-export smoke sibling.");
		}
		const sourceTree = await store.readSessionHistoryTreePage(sessionId);
		const rootEntry = sourceTree.entries.find(
			(entry) => entry.kind === "record" && entry.recordId === rootRecord.id
		);
		if (rootEntry === undefined) {
			throw new Error("Could not locate the branch-export smoke root.");
		}
		await store.navigateSessionHistory(sessionId, {
			targetEntryId: rootEntry.id,
			operationId: "smoke-branch-export-return-to-root",
		});
		const selectedRecord = createAssistantRecord(
			"smoke-branch-export-selected",
			"branch smoke selected answer",
			{ inputTokens: 11, outputTokens: 3 }
		);
		const selectedWrite = await store.commitSessionRecord({
			record: selectedRecord,
			sessionId,
		});
		if (selectedWrite.kind !== "committed") {
			throw new Error("Could not write the branch-export smoke selected path.");
		}
		const titleWrite = await store.updateSession(sessionId, {
			title: "branch-export-smoke-source",
		});
		if (titleWrite.kind !== "committed") {
			throw new Error("Could not title the branch-export smoke Session.");
		}
	} finally {
		close();
	}
}
