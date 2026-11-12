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
import { createDatabase } from "../../packages/coding-agent/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "../../packages/coding-agent/modules/sessions/storage/drizzle-session-store";
import {
	resolveLocalSessionLogRoot,
	resolveLocalSessionProjectionPath,
} from "../../packages/coding-agent/modules/sessions/storage/path";
import { createSessionJsonlStore } from "../../packages/coding-agent/modules/sessions/storage/session-jsonl-store";
import { buildUserSessionRecord } from "../../packages/coding-agent/modules/sessions/storage/session-record";
import { resolveUserDataDir } from "../../packages/coding-agent/shared/paths/user-data-dir";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionMessageId,
	sessionRecordId,
} from "../../packages/coding-agent/test/support/identifiers";

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
	const operational = createDatabase();
	const databasePath = operational.sqlite.filename;
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const projectionStore = createDrizzleSessionStore(projection.db, {
		operationalDatabase: operational.db,
		sessionLogRoot: logRoot,
		workspaceRoot: process.env.WINCODE_SMOKE_WORKSPACE,
	});
	const store = createSessionJsonlStore(projectionStore, logRoot);
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
		projection.sqlite.close();
		operational.sqlite.close();
	}
}
