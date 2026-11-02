import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { toSubmissionId } from "@wincode/agent-core";
import type { ProviderModel } from "@wincode/ai";
import { buildAgentRegistry } from "@/modules/agents/registry";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import { attachmentReferenceToFilePart } from "@/modules/sessions/attachment-reference";
import { createSessionHostManager } from "@/modules/sessions/host/session-host-manager";
import type { SessionHostManager } from "@/modules/sessions/host/types";
import { createSessionUserMessage } from "@/modules/sessions/message";
import { createSessionSdkWithRuntime } from "@/modules/sessions/sdk";
import type {
	SessionSdk,
	SessionSdkHandle,
} from "@/modules/sessions/sdk-contract";
import type { SessionBundleManifest } from "@/modules/sessions/session-bundle-contract";
import { createSessionBundleExportOperation } from "@/modules/sessions/session-bundle-export";
import {
	createSessionBundleImportOperation,
	SessionBundleImportError,
} from "@/modules/sessions/session-bundle-import";
import {
	type AttachmentMaintenanceReport,
	createDrizzleAttachmentMetadataRepository,
	createSessionAttachmentStore,
	digestBytes,
	type SessionAttachmentStore,
} from "@/modules/sessions/storage/attachment-store";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import {
	resolveLocalSessionLogRoot,
	resolveLocalSessionProjectionPath,
} from "@/modules/sessions/storage/path";
import { SESSION_BUNDLE_IMPORT_RESOURCE_BUDGETS } from "@/modules/sessions/storage/session-bundle";
import {
	createSessionLogEvent,
	decodeSessionLog,
	encodeSessionLogLine,
	type SessionLogEnvelope,
} from "@/modules/sessions/storage/session-jsonl-codec";
import {
	createSessionJsonlStore,
	type SessionLogFileIo,
} from "@/modules/sessions/storage/session-jsonl-store";
import { buildUserSessionRecord } from "@/modules/sessions/storage/session-record";
import type {
	Session,
	SessionStore,
} from "@/modules/sessions/storage/session-store";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import { type SessionId, toSessionId } from "@/shared/identifiers";
import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
} from "../support/e2e-fake-runtime";
import {
	agentId,
	agentTurnId,
	providerModelSelectionFixture,
	sessionMessageId,
} from "../support/identifiers";

const PNG_PREFIX = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const missingDestinationAgentMessage =
	/Imported Session Agent 'source-only-agent' is unavailable in this destination/u;
const temporaryRoots: string[] = [];

type ImportFixture = Readonly<{
	attachmentRoot: string;
	attachmentStore: SessionAttachmentStore;
	close: () => Promise<void>;
	logRoot: string;
	getProjectedSession: (sessionId: SessionId) => Promise<Session>;
	manager: SessionHostManager;
	root: string;
	store: SessionStore;
	workspace: string;
}>;

afterEach(async () => {
	await Promise.all(
		temporaryRoots
			.splice(0)
			.map((root) => fs.rm(root, { force: true, recursive: true }))
	);
});

const createFixture = async (
	name: string,
	fileIo: SessionLogFileIo = {}
): Promise<ImportFixture> => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `wincode-${name}-`));
	temporaryRoots.push(root);
	const workspace = path.join(root, "workspace");
	const databasePath = path.join(root, "sessions.sqlite");
	await fs.mkdir(workspace, { recursive: true });
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const attachmentRoot = path.join(root, "attachments");
	const attachmentStore = createSessionAttachmentStore({
		lifecycleRoot: logRoot,
		repository: createDrizzleAttachmentMetadataRepository(projection.db),
		root: attachmentRoot,
	});
	const projectionStore = createDrizzleSessionStore(projection.db, {
		attachmentRoot,
		attachmentStore,
		operationalDatabase: operational.db,
		sessionLogRoot: logRoot,
		workspaceRoot: workspace,
	});
	const store = createSessionJsonlStore(projectionStore, logRoot, fileIo);
	const manager = createSessionHostManager();
	return {
		attachmentRoot,
		attachmentStore,
		close: async () => {
			await manager.shutdownAll();
			operational.sqlite.close();
			projection.sqlite.close();
		},
		getProjectedSession: projectionStore.getSession,
		logRoot,
		manager,
		root,
		store,
		workspace,
	};
};

const exportEmptySession = async (
	fixture: ImportFixture,
	id: string,
	destination: string
): Promise<void> => {
	const created = await fixture.store.createEmptySession({
		id: toSessionId(id),
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
	});
	if (created.writeOutcome.kind !== "committed") {
		throw new Error("The import source Session was not committed.");
	}
	await createSessionBundleExportOperation(
		fixture.manager,
		fixture.store
	)({
		destination,
		sessionId: created.id,
		sourceWorkspacePath: fixture.workspace,
	});
};

const appendBundleSubmissionStatus = async (
	bundlePath: string,
	status: "failed" | "pending" | "processed" | "processing"
): Promise<void> => {
	const manifestPath = path.join(bundlePath, "manifest.json");
	const manifest = (await Bun.file(
		manifestPath
	).json()) as SessionBundleManifest;
	const sessionId = toSessionId(manifest.session.id);
	const logPath = path.join(bundlePath, manifest.sessionFile.path);
	const originalBytes = await Bun.file(logPath).bytes();
	const state = decodeSessionLog(sessionId, originalBytes);
	const previousStatus = state.entries.findLast(
		({ envelope }) => envelope.type === "submission.status-updated"
	);
	if (previousStatus?.envelope.type !== "submission.status-updated") {
		throw new Error("The bundle has no Submission status to extend.");
	}
	const nextStatus = createSessionLogEvent({
		operationId: "invalid-submission-status-transition",
		payload: { ...previousStatus.envelope.payload, status },
		previousHash: state.lastHash,
		sequence: state.nextSequence,
		sessionId,
		timestamp: new Date().toISOString(),
		type: "submission.status-updated",
	});
	const statusBytes = encodeSessionLogLine(nextStatus);
	const logBytes = new Uint8Array(
		originalBytes.byteLength + statusBytes.byteLength
	);
	logBytes.set(originalBytes);
	logBytes.set(statusBytes, originalBytes.byteLength);
	await Bun.write(logPath, logBytes);
	await Bun.write(
		manifestPath,
		JSON.stringify({
			...manifest,
			cut: { hash: nextStatus.entryHash, sequence: nextStatus.sequence },
			sessionFile: {
				...manifest.sessionFile,
				byteLength: logBytes.byteLength,
				sha256: digestBytes(logBytes),
			},
		})
	);
};

const rewriteBundleWithMissingSubmissionStatusReference = async (
	bundlePath: string
): Promise<void> => {
	const manifestPath = path.join(bundlePath, "manifest.json");
	const manifest = (await Bun.file(
		manifestPath
	).json()) as SessionBundleManifest;
	const sessionId = toSessionId(manifest.session.id);
	const logPath = path.join(bundlePath, manifest.sessionFile.path);
	const original = decodeSessionLog(sessionId, await Bun.file(logPath).bytes());
	let previousHash: string | null = null;
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	for (const { envelope } of original.entries) {
		const rewritten: SessionLogEnvelope =
			envelope.type === "session.header"
				? envelope
				: createSessionLogEvent({
						operationId: envelope.operationId,
						payload:
							envelope.type === "submission.status-updated"
								? { ...envelope.payload, recordId: "missing-submission-record" }
								: envelope.payload,
						previousHash,
						sequence: envelope.sequence,
						sessionId: envelope.sessionId,
						timestamp: envelope.timestamp,
						type: envelope.type,
					});
		previousHash = rewritten.entryHash;
		const chunk = encodeSessionLogLine(rewritten);
		chunks.push(chunk);
		byteLength += chunk.byteLength;
	}
	const logBytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		logBytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	await Bun.write(logPath, logBytes);
	await Bun.write(
		manifestPath,
		JSON.stringify({
			...manifest,
			cut: {
				hash: previousHash ?? manifest.cut.hash,
				sequence: original.nextSequence - 1,
			},
			sessionFile: {
				...manifest.sessionFile,
				byteLength: logBytes.byteLength,
				sha256: digestBytes(logBytes),
			},
		})
	);
};

test("import rejects an incomplete attachment closure without publishing a partial Session", async () => {
	const source = await createFixture("session-import-missing-source");
	const target = await createFixture("session-import-missing-target");
	try {
		const created = await source.store.createEmptySession({
			id: toSessionId("bundle-import-missing-blob"),
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		if (created.writeOutcome.kind !== "committed") {
			throw new Error("The import source Session was not committed.");
		}
		const attachment = await source.attachmentStore.ingest({
			bytes: new Uint8Array([...PNG_PREFIX, 5]),
			filename: "missing.png",
			mediaType: "image/png",
		});
		try {
			const message = {
				...{
					id: sessionMessageId("bundle-import-missing-blob-message"),
					parts: [attachmentReferenceToFilePart(attachment.reference)],
					role: "user" as const,
				},
			};
			const record = buildUserSessionRecord({
				agentId: agentId("build"),
				message,
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				turnId: agentTurnId("bundle-import-missing-blob-turn"),
			});
			const outcome = await source.store.commitSessionRecord({
				record,
				sessionId: created.id,
			});
			if (outcome.kind !== "committed") {
				throw new Error("The import source record was not committed.");
			}
		} finally {
			await attachment.release();
		}
		const bundlePath = path.join(source.root, "bundle");
		await createSessionBundleExportOperation(
			source.manager,
			source.store
		)({
			destination: bundlePath,
			sessionId: created.id,
		});
		const manifest = await Bun.file(
			path.join(bundlePath, "manifest.json")
		).json();
		const attachmentPath = path.join(bundlePath, manifest.attachments[0].path);
		await fs.unlink(attachmentPath);

		const importBundle = createSessionBundleImportOperation(target.store);
		await expect(importBundle({ bundlePath })).rejects.toMatchObject({
			code: "session_bundle_invalid",
		});
		expect(await target.store.listSessions()).toEqual([]);
		expect(
			await Bun.file(
				path.join(target.logRoot, created.id, "session.jsonl")
			).exists()
		).toBe(false);
	} finally {
		await source.close();
		await target.close();
	}
});

test("bundle rejects attachment metadata that disagrees with log references before publishing", async () => {
	const source = await createFixture(
		"session-import-attachment-metadata-source"
	);
	const target = await createFixture(
		"session-import-attachment-metadata-target"
	);
	const sessionId = toSessionId("bundle-import-attachment-metadata");
	try {
		const created = await source.store.createEmptySession({
			id: sessionId,
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		if (created.writeOutcome.kind !== "committed") {
			throw new Error(
				"The attachment metadata source Session was not committed."
			);
		}
		const attachment = await source.attachmentStore.ingest({
			bytes: new Uint8Array([...PNG_PREFIX, 11]),
			filename: "source.png",
			mediaType: "image/png",
		});
		try {
			const record = buildUserSessionRecord({
				agentId: agentId("build"),
				message: {
					id: sessionMessageId("bundle-import-attachment-metadata-message"),
					parts: [attachmentReferenceToFilePart(attachment.reference)],
					role: "user",
				},
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				turnId: agentTurnId("bundle-import-attachment-metadata-turn"),
			});
			const committed = await source.store.commitSessionRecord({
				record,
				sessionId,
			});
			expect(committed.kind).toBe("committed");
		} finally {
			await attachment.release();
		}

		const bundlePath = path.join(source.root, "bundle");
		await createSessionBundleExportOperation(
			source.manager,
			source.store
		)({ destination: bundlePath, sessionId });
		const manifestPath = path.join(bundlePath, "manifest.json");
		const manifest = (await Bun.file(
			manifestPath
		).json()) as SessionBundleManifest;
		const attachmentEntry = manifest.attachments[0];
		if (attachmentEntry === undefined) {
			throw new Error("The exported bundle has no attachment entry.");
		}
		const importBundle = createSessionBundleImportOperation(target.store);
		for (const metadata of [
			{ filename: "different.png" },
			{ width: 1 },
			{ height: 1 },
		]) {
			await Bun.write(
				manifestPath,
				JSON.stringify({
					...manifest,
					attachments: [{ ...attachmentEntry, ...metadata }],
				})
			);
			await expect(importBundle({ bundlePath })).rejects.toMatchObject({
				code: "session_bundle_invalid",
			});
			expect(await target.store.listSessions()).toEqual([]);
			expect(
				await Bun.file(
					path.join(target.logRoot, sessionId, "session.jsonl")
				).exists()
			).toBe(false);
		}
	} finally {
		await source.close();
		await target.close();
	}
});

test("a deleted Session ID remains reserved against repeated bundle imports", async () => {
	const source = await createFixture("session-import-deleted-source");
	const target = await createFixture("session-import-deleted-target");
	const sessionId = toSessionId("bundle-import-deleted-target");
	const bundlePath = path.join(source.root, "bundle");
	try {
		await exportEmptySession(source, sessionId, bundlePath);
		const created = await target.store.createEmptySession({
			id: sessionId,
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		if (created.writeOutcome.kind !== "committed") {
			throw new Error("The deleted import target was not committed.");
		}
		const deletion = await target.store.deleteSession(sessionId);
		expect(deletion.kind).toBe("committed");

		const importBundle = createSessionBundleImportOperation(target.store);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			await expect(importBundle({ bundlePath })).rejects.toMatchObject({
				code: "session_import_conflict",
			});
			expect(await target.store.listSessions()).toEqual([]);
			expect(
				await Bun.file(
					path.join(target.logRoot, sessionId, "session.jsonl")
				).exists()
			).toBe(false);
		}
	} finally {
		await source.close();
		await target.close();
	}
});

test("identical imports are no-ops, while a same-ID prefix extension is a conflict", async () => {
	const source = await createFixture("session-import-identity-source");
	const target = await createFixture("session-import-identity-target");
	try {
		const sessionId = "bundle-import-identity";
		const originalBundle = path.join(source.root, "original-bundle");
		await exportEmptySession(source, sessionId, originalBundle);
		const importBundle = createSessionBundleImportOperation(target.store);
		const first = await importBundle({ bundlePath: originalBundle });
		const repeated = await importBundle({ bundlePath: originalBundle });
		expect(first.status).toBe("imported");
		expect(repeated).toMatchObject({
			activationPending: true,
			sessionId: toSessionId(sessionId),
			status: "unchanged",
		});

		const sourceId = toSessionId(sessionId);
		const confirmActivation = target.store.confirmSessionImportActivation;
		if (confirmActivation === undefined) {
			throw new Error("Session import activation storage is unavailable.");
		}
		await confirmActivation(sourceId);
		const afterActivation = await importBundle({ bundlePath: originalBundle });
		expect(afterActivation).toMatchObject({
			activationPending: false,
			sessionId: sourceId,
			status: "unchanged",
		});

		await target.store.updateSession(sourceId, {
			title: "Continued locally after import",
		});
		const localSubmissionId = toSubmissionId(
			"bundle-import-identity-local-submission"
		);
		const localInput = await target.store.commitSessionRecord({
			record: buildUserSessionRecord({
				agentId: agentId("build"),
				message: {
					id: sessionMessageId("bundle-import-identity-local-message"),
					metadata: {
						submissionId: localSubmissionId,
						submissionStatus: "pending",
					},
					parts: [{ text: "Continue locally after import.", type: "text" }],
					role: "user",
				},
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				turnId: agentTurnId("bundle-import-identity-local-turn"),
			}),
			sessionId: sourceId,
		});
		expect(localInput.kind).toBe("committed");
		const afterLocalContinuation = await importBundle({
			bundlePath: originalBundle,
		});
		expect(afterLocalContinuation).toMatchObject({
			activationPending: false,
			sessionId: sourceId,
			status: "unchanged",
		});

		await source.store.updateSession(sourceId, {
			title: "Extended after the imported cut",
		});
		const extendedBundle = path.join(source.root, "extended-bundle");
		await createSessionBundleExportOperation(
			source.manager,
			source.store
		)({
			destination: extendedBundle,
			sessionId: sourceId,
		});
		await expect(
			importBundle({ bundlePath: extendedBundle })
		).rejects.toBeInstanceOf(SessionBundleImportError);
		await expect(
			importBundle({ bundlePath: extendedBundle })
		).rejects.toMatchObject({
			code: "session_import_conflict",
		});
		expect(await target.store.getSession(sourceId)).toMatchObject({
			title: "Continued locally after import",
		});
	} finally {
		await source.close();
		await target.close();
	}
});

test("a forked imported Session keeps attachments live after deleting and collecting its source", async () => {
	const source = await createFixture("session-import-fork-source");
	const target = await createFixture("session-import-fork-target");
	const attachmentBytes = new Uint8Array([...PNG_PREFIX, 7]);
	try {
		const attachmentLease = await source.attachmentStore.ingest({
			bytes: attachmentBytes,
			filename: "portable-fork.png",
			mediaType: "image/png",
		});
		try {
			const attachmentReference = attachmentLease.reference;
			const created = await source.store.createSession({
				agent: agentId("build"),
				message: createSessionUserMessage(
					"Keep the portable attachment in a fork.",
					undefined,
					[],
					[attachmentReferenceToFilePart(attachmentReference)]
				),
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				turnId: agentTurnId("session-import-fork-turn"),
			});
			if (created.writeOutcome.kind !== "committed") {
				throw new Error("The import source Session was not committed.");
			}

			const bundlePath = path.join(source.root, "fork-source-bundle");
			await createSessionBundleExportOperation(
				source.manager,
				source.store
			)({
				destination: bundlePath,
				sessionId: created.id,
			});
			const imported = await createSessionBundleImportOperation(target.store)({
				bundlePath,
			});
			const importedRecords = await target.store.listSessionRecords(
				imported.sessionId
			);
			const importedUserRecord = importedRecords[0];
			if (importedUserRecord === undefined) {
				throw new Error("The imported Session has no accepted user record.");
			}
			const forked = await target.store.forkSession(
				imported.sessionId,
				{ recordId: importedUserRecord.id },
				"session-import-fork-delete-source"
			);
			expect(forked.created).toBe(true);

			const deletion = await target.store.deleteSession(imported.sessionId);
			expect(deletion).toMatchObject({
				kind: "committed",
				projection: "ready",
			});
			await target.attachmentStore.collect({
				liveAttachmentIds: [],
				safetyWindowMs: 0,
			});

			const resolved =
				await target.attachmentStore.resolve(attachmentReference);
			if (resolved.availability !== "available") {
				throw new Error(
					"The fork attachment was not retained after source deletion and GC."
				);
			}
			expect(resolved.bytes).toEqual(attachmentBytes);
			expect((await target.store.listSessions()).map(({ id }) => id)).toEqual([
				forked.id,
			]);
			expect(
				await target.store.getSessionForkProvenance(forked.id)
			).toMatchObject({ sourceSessionId: imported.sessionId });
		} finally {
			await attachmentLease.release();
		}
	} finally {
		await source.close();
		await target.close();
	}
});

test("import requires the destination to configure the historical Agent identity", async () => {
	const source = await createFixture("session-import-agent-source");
	const target = await createFixture("session-import-agent-target");
	const sessionId = toSessionId("bundle-import-agent-identity");
	const sourceAgent = agentId("source-only-agent");
	let missingAgentSdk: SessionSdk | undefined;
	let configuredAgentSdk: SessionSdk | undefined;
	let handle: SessionSdkHandle | undefined;
	try {
		const created = await source.store.createEmptySession({
			id: sessionId,
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		if (created.writeOutcome.kind !== "committed") {
			throw new Error("The import source Session was not committed.");
		}
		const submissionId = toSubmissionId("bundle-import-agent-submission");
		const record = buildUserSessionRecord({
			agentId: sourceAgent,
			message: {
				id: sessionMessageId("bundle-import-agent-message"),
				metadata: {
					agent: sourceAgent,
					model: DEFAULT_PROVIDER_MODEL_SELECTION,
					submissionId,
					submissionStatus: "pending",
				},
				parts: [
					{
						text: "Keep this work idle until its Agent is available.",
						type: "text",
					},
				],
				role: "user",
			},
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: agentTurnId("bundle-import-agent-turn"),
		});
		const committed = await source.store.commitSessionRecord({
			record,
			sessionId,
		});
		if (committed.kind !== "committed") {
			throw new Error("The import source submission was not committed.");
		}
		const bundlePath = path.join(source.root, "bundle");
		await createSessionBundleExportOperation(
			source.manager,
			source.store
		)({ destination: bundlePath, sessionId });
		await createSessionBundleImportOperation(target.store)({ bundlePath });

		missingAgentSdk = await createSessionSdkWithRuntime({
			createProviderCollection: () =>
				createFakeProviderCollection(createFakeProviderRecorder()),
			cwd: target.workspace,
			pluginPaths: [],
			store: target.store,
			workspace: target.workspace,
		});
		await expect(
			missingAgentSdk.openSession(sessionId, { autoContinue: true })
		).rejects.toThrow(missingDestinationAgentMessage);
		expect(
			await target.store.isSessionImportActivationPending?.(sessionId)
		).toBe(true);
		await missingAgentSdk.dispose();
		missingAgentSdk = undefined;

		const targetRegistry = buildAgentRegistry(
			fromPartial<ConfigSnapshot>({
				diagnostics: [],
				document: {
					agents: {
						[sourceAgent]: {
							description: "Preserves the source Session Agent identity.",
							instructions: "Continue using this Agent.",
							role: "primary",
						},
					},
					default_agent: sourceAgent,
				},
				sourceFor: () => undefined,
				sources: [],
			})
		);
		const recorder = createFakeProviderRecorder();
		configuredAgentSdk = await createSessionSdkWithRuntime({
			createProviderCollection: () => createFakeProviderCollection(recorder),
			cwd: target.workspace,
			getRegistry: () => targetRegistry,
			pluginPaths: [],
			store: target.store,
			workspace: target.workspace,
		});
		handle = await configuredAgentSdk.openSession(sessionId, {
			autoContinue: false,
		});
		const completed = Promise.withResolvers<void>();
		const unsubscribe = handle.onEvent((event) => {
			if (event.type === "agent-turn-completed") {
				completed.resolve();
			}
		});
		try {
			await handle.continue();
			await completed.promise;
		} finally {
			unsubscribe();
		}
		expect(recorder.requests).toHaveLength(1);
		const records = await target.store.listSessionRecords(sessionId);
		expect(records.at(-1)?.agentId).toBe(sourceAgent);

		await handle.dispose();
		handle = undefined;
		await configuredAgentSdk.dispose();
		configuredAgentSdk = undefined;
		missingAgentSdk = await createSessionSdkWithRuntime({
			createProviderCollection: () =>
				createFakeProviderCollection(createFakeProviderRecorder()),
			cwd: target.workspace,
			pluginPaths: [],
			store: target.store,
			workspace: target.workspace,
		});
		expect(
			await target.store.isSessionImportActivationPending?.(sessionId)
		).toBe(false);
		await expect(
			missingAgentSdk.openSession(sessionId, { autoContinue: false })
		).rejects.toThrow(missingDestinationAgentMessage);
	} finally {
		await handle?.dispose();
		await missingAgentSdk?.dispose();
		await configuredAgentSdk?.dispose();
		await source.close();
		await target.close();
	}
});

test("an unavailable imported Provider Model cannot fall back from its historical Agent", async () => {
	const source = await createFixture("session-import-provider-source");
	const target = await createFixture("session-import-provider-target");
	const sessionId = toSessionId("bundle-import-provider-identity");
	const sourceAgent = agentId("source-provider-agent");
	const sourceModel = providerModelSelectionFixture(
		"anthropic/source-only-model"
	);
	const destinationModel = providerModelSelectionFixture(
		"openai/session-import-destination-model"
	);
	const destinationProviderModel: ProviderModel = {
		capabilities: ["reasoning", "text", "tools"],
		limits: { contextWindowTokens: 200_000 },
		modelId: destinationModel.modelId,
		protocolId: "fake-e2e-provider",
		providerId: destinationModel.providerId,
	};
	const recorder = createFakeProviderRecorder();
	let sdk: SessionSdk | undefined;
	let handle: SessionSdkHandle | undefined;
	try {
		const created = await source.store.createEmptySession({
			id: sessionId,
			model: sourceModel,
		});
		if (created.writeOutcome.kind !== "committed") {
			throw new Error("The import source Session was not committed.");
		}
		const record = buildUserSessionRecord({
			agentId: sourceAgent,
			message: {
				id: sessionMessageId("bundle-import-provider-message"),
				metadata: { agent: sourceAgent, model: sourceModel },
				parts: [
					{
						text: "Keep this historical Agent and model selection.",
						type: "text",
					},
				],
				role: "user",
			},
			model: sourceModel,
			turnId: agentTurnId("bundle-import-provider-turn"),
		});
		const committed = await source.store.commitSessionRecord({
			record,
			sessionId,
		});
		if (committed.kind !== "committed") {
			throw new Error("The import source record was not committed.");
		}
		const bundlePath = path.join(source.root, "bundle");
		await createSessionBundleExportOperation(
			source.manager,
			source.store
		)({ destination: bundlePath, sessionId });
		await createSessionBundleImportOperation(target.store)({ bundlePath });

		const targetRegistry = buildAgentRegistry(
			fromPartial<ConfigSnapshot>({
				diagnostics: [],
				document: {
					agents: {
						[sourceAgent]: {
							description: "Preserves the imported Agent identity.",
							instructions: "Continue using this Agent.",
							role: "primary",
						},
					},
					default_agent: agentId("build"),
				},
				sourceFor: () => undefined,
				sources: [],
			})
		);
		sdk = await createSessionSdkWithRuntime({
			createProviderCollection: () =>
				createFakeProviderCollection(recorder, destinationProviderModel),
			cwd: target.workspace,
			getRegistry: () => targetRegistry,
			pluginPaths: [],
			store: target.store,
			workspace: target.workspace,
		});
		handle = await sdk.openSession(sessionId, { autoContinue: true });
		expect(
			await target.store.isSessionImportActivationPending?.(sessionId)
		).toBe(true);
		expect(recorder.requests).toEqual([]);

		await expect(
			handle.prompt({ text: "Do not choose a fallback Provider Model." })
		).rejects.toThrow(
			"Provider Model anthropic/source-only-model is unavailable"
		);
		expect(recorder.requests).toEqual([]);

		const completed = Promise.withResolvers<void>();
		const unsubscribe = handle.onEvent((event) => {
			if (event.type === "agent-turn-completed") {
				completed.resolve();
			}
		});
		try {
			const validPrompt = await handle.prompt({
				model: destinationModel,
				text: "Run only with an explicitly selected destination model.",
			});
			expect(validPrompt).toMatchObject({ rejected: false });
			await completed.promise;
		} finally {
			unsubscribe();
		}
		expect(recorder.requests).toHaveLength(1);
		expect(recorder.requests[0]?.model).toEqual({
			modelId: destinationProviderModel.modelId,
			providerId: destinationProviderModel.providerId,
		});
		expect(
			(await target.store.listSessionRecords(sessionId)).at(-1)
		).toMatchObject({
			agentId: sourceAgent,
			model: destinationModel,
		});
	} finally {
		await handle?.dispose();
		await sdk?.dispose();
		await source.close();
		await target.close();
	}
});

test("import activation remains pending across projection rebuild and is logged before release", async () => {
	const source = await createFixture("session-import-activation-source");
	const target = await createFixture("session-import-activation-target");
	try {
		const bundlePath = path.join(source.root, "bundle");
		await exportEmptySession(source, "bundle-import-activation", bundlePath);
		const imported = await createSessionBundleImportOperation(target.store)({
			bundlePath,
		});
		const sessionId = toSessionId(imported.sessionId);
		const activationPending = target.store.isSessionImportActivationPending;
		const confirmActivation = target.store.confirmSessionImportActivation;
		expect(activationPending).toBeDefined();
		expect(confirmActivation).toBeDefined();
		if (activationPending === undefined || confirmActivation === undefined) {
			throw new Error("Session import activation storage is unavailable.");
		}
		expect(await activationPending(sessionId)).toBe(true);
		await target.store.rebuildProjection(
			{ kind: "all" },
			async (operation) => await operation()
		);
		expect(await activationPending(sessionId)).toBe(true);

		await confirmActivation(sessionId);
		expect(await activationPending(sessionId)).toBe(false);
		const logBytes = await Bun.file(
			path.join(target.logRoot, sessionId, "session.jsonl")
		).bytes();
		const state = decodeSessionLog(sessionId, logBytes);
		const activation = state.entries.at(-1);
		expect(activation?.envelope.type).toBe("session.activation-confirmed");
	} finally {
		await source.close();
		await target.close();
	}
});

test("imported pending work stays idle until explicit SDK continuation records activation", async () => {
	const source = await createFixture("session-import-gated-source");
	const target = await createFixture("session-import-gated-target");
	let sdk: SessionSdk | undefined;
	let handle: SessionSdkHandle | undefined;
	let autoContinueHandle: SessionSdkHandle | undefined;
	try {
		const sessionId = toSessionId("bundle-import-gated-work");
		const created = await source.store.createEmptySession({
			id: sessionId,
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		if (created.writeOutcome.kind !== "committed") {
			throw new Error("The import source Session was not committed.");
		}
		const submissionId = toSubmissionId("bundle-import-gated-submission");
		const pendingRecord = buildUserSessionRecord({
			agentId: agentId("build"),
			message: {
				id: sessionMessageId("bundle-import-gated-message"),
				metadata: {
					agent: agentId("build"),
					model: DEFAULT_PROVIDER_MODEL_SELECTION,
					submissionId,
					submissionStatus: "pending",
				},
				parts: [
					{
						text: "Run only after I explicitly activate this import.",
						type: "text",
					},
				],
				role: "user",
			},
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: agentTurnId("bundle-import-gated-turn"),
		});
		const recordOutcome = await source.store.commitSessionRecord({
			record: pendingRecord,
			sessionId,
		});
		if (recordOutcome.kind !== "committed") {
			throw new Error("The import source submission was not committed.");
		}
		const bundlePath = path.join(source.root, "bundle");
		await createSessionBundleExportOperation(
			source.manager,
			source.store
		)({
			destination: bundlePath,
			sessionId,
		});
		const recorder = createFakeProviderRecorder();
		let activationWasDurableBeforeProvider = false;
		const providerStarted = Promise.withResolvers<void>();
		recorder.beforeChat = async () => {
			const bytes = await Bun.file(
				path.join(target.logRoot, sessionId, "session.jsonl")
			).bytes();
			activationWasDurableBeforeProvider = decodeSessionLog(
				sessionId,
				bytes
			).entries.some(
				(entry) => entry.envelope.type === "session.activation-confirmed"
			);
		};
		recorder.afterTextDelta = async () => providerStarted.resolve();
		sdk = await createSessionSdkWithRuntime({
			createProviderCollection: () => createFakeProviderCollection(recorder),
			cwd: target.workspace,
			pluginPaths: [],
			store: target.store,
			workspace: target.workspace,
		});
		await sdk.importSessionBundle(bundlePath);
		await target.store.rebuildProjection(
			{ kind: "all" },
			async (operation) => await operation()
		);
		handle = await sdk.openSession(sessionId, { autoContinue: false });
		autoContinueHandle = await sdk.openSession(sessionId, {
			autoContinue: true,
		});
		expect(
			await target.store.isSessionImportActivationPending?.(sessionId)
		).toBe(true);
		expect(recorder.requests).toEqual([]);

		await autoContinueHandle.continue();
		await providerStarted.promise;
		expect(activationWasDurableBeforeProvider).toBe(true);
		expect(recorder.requests).toHaveLength(1);
	} finally {
		await autoContinueHandle?.dispose();
		await handle?.dispose();
		await sdk?.dispose();
		await source.close();
		await target.close();
	}
});

test("a crash after marker durability is retryable without exposing a half-written log", async () => {
	const source = await createFixture("session-import-crash-source");
	const target = await createFixture("session-import-crash-target");
	try {
		const bundlePath = path.join(source.root, "bundle");
		await exportEmptySession(source, "bundle-import-crash", bundlePath);
		const failingImport = createSessionBundleImportOperation(target.store, {
			afterActivationMarker: async () => {
				throw new Error("injected crash after marker sync");
			},
		});
		await expect(failingImport({ bundlePath })).rejects.toMatchObject({
			code: "session_import_failed",
		});
		const sessionId = toSessionId("bundle-import-crash");
		expect(await target.store.listSessions()).toEqual([]);
		expect(
			await target.store.isSessionImportActivationPending?.(sessionId)
		).toBe(true);

		const retried = await createSessionBundleImportOperation(target.store)({
			bundlePath,
		});
		expect(retried.status).toBe("imported");
		expect(
			await target.store.isSessionImportActivationPending?.(sessionId)
		).toBe(true);
		expect(await target.store.listSessions()).toHaveLength(1);
	} finally {
		await source.close();
		await target.close();
	}
});

test("a fresh catalog page and retry recover a durable imported log after projection failure", async () => {
	const source = await createFixture("session-import-published-crash-source");
	const target = await createFixture("session-import-published-crash-target");
	try {
		const bundlePath = path.join(source.root, "bundle");
		const sessionId = toSessionId("bundle-import-published-crash");
		const created = await source.store.createEmptySession({
			id: sessionId,
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		if (created.writeOutcome.kind !== "committed") {
			throw new Error("The import source Session was not committed.");
		}
		await source.store.updateSession(sessionId, {
			title: "Crash recovery title",
		});
		await createSessionBundleExportOperation(
			source.manager,
			source.store
		)({
			destination: bundlePath,
			sessionId,
		});
		const interruptedImport = createSessionBundleImportOperation(target.store, {
			afterPublish: async () => {
				throw new Error("injected crash after durable log publication");
			},
		});
		await expect(interruptedImport({ bundlePath })).rejects.toMatchObject({
			code: "session_import_indeterminate",
		});
		await expect(target.getProjectedSession(sessionId)).rejects.toThrow();

		const page = await target.store.listSessionsPage({ limit: 10 });
		expect(page.sessions.find(({ id }) => id === sessionId)).toMatchObject({
			id: sessionId,
			title: "Crash recovery title",
		});

		const retry = await createSessionBundleImportOperation(target.store)({
			bundlePath,
		});
		expect(retry).toMatchObject({
			status: "unchanged",
			activationPending: true,
		});
		expect(await target.getProjectedSession(sessionId)).toMatchObject({
			title: "Crash recovery title",
		});
	} finally {
		await source.close();
		await target.close();
	}
});

test("bundle rejects an unresolved submission status reference before publishing a Session", async () => {
	const source = await createFixture("session-import-status-reference-source");
	const target = await createFixture("session-import-status-reference-target");
	try {
		const sessionId = toSessionId("bundle-import-status-reference");
		const created = await source.store.createEmptySession({
			id: sessionId,
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		if (created.writeOutcome.kind !== "committed") {
			throw new Error("The import source Session was not committed.");
		}
		const submissionId = toSubmissionId("bundle-import-status-submission");
		const messageId = sessionMessageId("bundle-import-status-message");
		const record = buildUserSessionRecord({
			agentId: agentId("build"),
			message: {
				id: messageId,
				metadata: {
					agent: agentId("build"),
					model: DEFAULT_PROVIDER_MODEL_SELECTION,
					submissionId,
					submissionStatus: "pending",
				},
				parts: [
					{
						text: "The status event must resolve this submission.",
						type: "text",
					},
				],
				role: "user",
			},
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: agentTurnId("bundle-import-status-turn"),
		});
		const committed = await source.store.commitSessionRecord({
			record,
			sessionId,
		});
		if (committed.kind !== "committed") {
			throw new Error("The import source submission was not committed.");
		}
		const statusUpdated = await source.store.updateSessionSubmission({
			messageId,
			recordId: record.id,
			sessionId,
			status: "processing",
			submissionId,
		});
		if (statusUpdated.kind !== "committed") {
			throw new Error("The source submission status was not committed.");
		}
		const bundlePath = path.join(source.root, "bundle");
		await createSessionBundleExportOperation(
			source.manager,
			source.store
		)({ destination: bundlePath, sessionId });
		await rewriteBundleWithMissingSubmissionStatusReference(bundlePath);

		await expect(
			createSessionBundleImportOperation(target.store)({ bundlePath })
		).rejects.toMatchObject({ code: "session_bundle_invalid" });
		expect(await target.store.listSessions()).toEqual([]);
		expect(
			await Bun.file(
				path.join(target.logRoot, sessionId, "session.jsonl")
			).exists()
		).toBe(false);
		expect(
			await target.store.isSessionImportActivationPending?.(sessionId)
		).toBe(false);
	} finally {
		await source.close();
		await target.close();
	}
});

test("bundle rejects processed Submission status returning to pending before import publication", async () => {
	const source = await createFixture("session-import-status-transition-source");
	const target = await createFixture("session-import-status-transition-target");
	try {
		const sessionId = toSessionId("bundle-import-status-transition");
		const created = await source.store.createEmptySession({
			id: sessionId,
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		if (created.writeOutcome.kind !== "committed") {
			throw new Error("The import source Session was not committed.");
		}
		const submissionId = toSubmissionId(
			"bundle-import-status-transition-submission"
		);
		const messageId = sessionMessageId(
			"bundle-import-status-transition-message"
		);
		const record = buildUserSessionRecord({
			agentId: agentId("build"),
			message: {
				id: messageId,
				metadata: {
					agent: agentId("build"),
					model: DEFAULT_PROVIDER_MODEL_SELECTION,
					submissionId,
					submissionStatus: "pending",
				},
				parts: [
					{ text: "This Submission has already completed.", type: "text" },
				],
				role: "user",
			},
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: agentTurnId("bundle-import-status-transition-turn"),
		});
		const committed = await source.store.commitSessionRecord({
			record,
			sessionId,
		});
		if (committed.kind !== "committed") {
			throw new Error("The source Submission was not committed.");
		}
		for (const status of [
			"processing",
			"failed",
			"processing",
			"processed",
		] as const) {
			const updated = await source.store.updateSessionSubmission({
				messageId,
				recordId: record.id,
				sessionId,
				status,
				submissionId,
				...(status === "failed"
					? { failure: "The first attempt must be retried." }
					: {}),
			});
			if (updated.kind !== "committed") {
				throw new Error(`The source Submission did not become ${status}.`);
			}
		}
		const bundlePath = path.join(source.root, "bundle");
		await createSessionBundleExportOperation(
			source.manager,
			source.store
		)({
			destination: bundlePath,
			sessionId,
		});
		await appendBundleSubmissionStatus(bundlePath, "pending");

		await expect(
			createSessionBundleImportOperation(target.store)({ bundlePath })
		).rejects.toMatchObject({ code: "session_bundle_invalid" });
		expect(await target.store.listSessions()).toEqual([]);
		expect(
			await Bun.file(
				path.join(target.logRoot, sessionId, "session.jsonl")
			).exists()
		).toBe(false);
		expect(
			await target.store.isSessionImportActivationPending?.(sessionId)
		).toBe(false);
	} finally {
		await source.close();
		await target.close();
	}
});

test("partial activation-marker writes are cleaned so a retry can publish", async () => {
	let injectPartialWriteFailure = true;
	const fileIo: SessionLogFileIo = {
		write: async (filePath, handle, bytes, offset, length, position) => {
			if (
				injectPartialWriteFailure &&
				filePath.includes(
					`${path.sep}session-control${path.sep}imports${path.sep}`
				)
			) {
				injectPartialWriteFailure = false;
				await handle.write(
					bytes,
					offset,
					Math.max(1, Math.floor(length / 2)),
					position
				);
				throw new Error("injected partial activation-marker write");
			}
			const result = await handle.write(bytes, offset, length, position);
			return result.bytesWritten;
		},
	};
	const source = await createFixture("session-import-marker-write-source");
	const target = await createFixture(
		"session-import-marker-write-target",
		fileIo
	);
	try {
		const bundlePath = path.join(source.root, "bundle");
		const sessionId = toSessionId("bundle-import-marker-write");
		await exportEmptySession(source, sessionId, bundlePath);
		const importBundle = createSessionBundleImportOperation(target.store);

		await expect(importBundle({ bundlePath })).rejects.toMatchObject({
			code: "session_import_failed",
		});
		expect(await target.store.listSessions()).toEqual([]);
		expect(
			await target.store.isSessionImportActivationPending?.(sessionId)
		).toBe(false);
		expect(
			await Bun.file(
				path.join(target.logRoot, sessionId, "session.jsonl")
			).exists()
		).toBe(false);
		expect(await fs.readdir(path.join(target.logRoot, ".staging"))).toEqual([]);
		const markerDirectory = path.join(
			path.dirname(target.logRoot),
			"session-control",
			"imports"
		);
		expect(
			(await fs.readdir(markerDirectory)).filter((name) =>
				name.endsWith(".tmp")
			)
		).toEqual([]);

		await expect(importBundle({ bundlePath })).resolves.toMatchObject({
			activationPending: true,
			status: "imported",
		});
		expect(await target.store.listSessions()).toHaveLength(1);
	} finally {
		await source.close();
		await target.close();
	}
});

test("a published activation marker survives directory-sync failure for retry recovery", async () => {
	let injectMarkerDirectorySyncFailure = true;
	const fileIo: SessionLogFileIo = {
		syncDirectory: async (directory, handle) => {
			if (
				injectMarkerDirectorySyncFailure &&
				path.basename(directory) === "imports"
			) {
				injectMarkerDirectorySyncFailure = false;
				throw new Error("injected activation-marker directory sync failure");
			}
			await handle.sync();
		},
	};
	const source = await createFixture("session-import-marker-sync-source");
	const target = await createFixture(
		"session-import-marker-sync-target",
		fileIo
	);
	try {
		const bundlePath = path.join(source.root, "bundle");
		const sessionId = toSessionId("bundle-import-marker-sync");
		await exportEmptySession(source, sessionId, bundlePath);
		const importBundle = createSessionBundleImportOperation(target.store);

		await expect(importBundle({ bundlePath })).rejects.toMatchObject({
			code: "session_import_failed",
		});
		expect(await target.store.listSessions()).toEqual([]);
		expect(
			await target.store.isSessionImportActivationPending?.(sessionId)
		).toBe(true);
		await expect(importBundle({ bundlePath })).resolves.toMatchObject({
			activationPending: true,
			status: "imported",
		});
		expect(await target.store.listSessions()).toHaveLength(1);
	} finally {
		await source.close();
		await target.close();
	}
});

test("attachment collection during import staging and publication preserves imported blobs", async () => {
	const source = await createFixture("session-import-attachment-gc-source");
	const target = await createFixture("session-import-attachment-gc-target");
	try {
		const sessionId = toSessionId("bundle-import-attachment-gc");
		const created = await source.store.createEmptySession({
			id: sessionId,
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		if (created.writeOutcome.kind !== "committed") {
			throw new Error("The import source Session was not committed.");
		}
		const attachment = await source.attachmentStore.ingest({
			bytes: new Uint8Array([...PNG_PREFIX, 17]),
			filename: "imported.png",
			mediaType: "image/png",
		});
		const reference = attachment.reference;
		try {
			const record = buildUserSessionRecord({
				agentId: agentId("build"),
				message: {
					id: sessionMessageId("bundle-import-attachment-gc-message"),
					parts: [attachmentReferenceToFilePart(reference)],
					role: "user",
				},
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				turnId: agentTurnId("bundle-import-attachment-gc-turn"),
			});
			const committed = await source.store.commitSessionRecord({
				record,
				sessionId,
			});
			if (committed.kind !== "committed") {
				throw new Error("The source attachment record was not committed.");
			}
		} finally {
			await attachment.release();
		}
		const bundlePath = path.join(source.root, "bundle");
		await createSessionBundleExportOperation(
			source.manager,
			source.store
		)({
			destination: bundlePath,
			sessionId,
		});
		const attachmentsStaged = Promise.withResolvers<void>();
		const continuePublication = Promise.withResolvers<void>();
		let publicationCollection: Promise<AttachmentMaintenanceReport> | undefined;
		const importBundle = createSessionBundleImportOperation(target.store, {
			afterAttachmentsStaged: async () => {
				attachmentsStaged.resolve();
				await continuePublication.promise;
			},
			beforePublish: async () => {
				publicationCollection = target.attachmentStore.collect({
					liveAttachmentIds: [],
					safetyWindowMs: 0,
				});
			},
		});
		let importing: Promise<unknown> | undefined;
		try {
			importing = importBundle({ bundlePath });
			await attachmentsStaged.promise;
			await expect(
				target.attachmentStore.collect({
					liveAttachmentIds: [],
					safetyWindowMs: 0,
				})
			).resolves.toMatchObject({ reclaimedCount: 0 });
			await expect(
				target.attachmentStore.resolve(reference)
			).resolves.toMatchObject({
				availability: "available",
			});
			continuePublication.resolve();
			await expect(importing).resolves.toMatchObject({
				activationPending: true,
				status: "imported",
			});
			await expect(publicationCollection).resolves.toMatchObject({
				reclaimedCount: 0,
			});
			expect(await target.store.listSessions()).toHaveLength(1);
			await expect(
				target.attachmentStore.resolve(reference)
			).resolves.toMatchObject({
				availability: "available",
			});
		} finally {
			continuePublication.resolve();
			await importing?.catch(() => undefined);
			await publicationCollection?.catch(() => undefined);
		}
	} finally {
		await source.close();
		await target.close();
	}
});

test("bundle resource budgets reject oversized declared logs before import publication", async () => {
	const source = await createFixture("session-import-budget-source");
	const target = await createFixture("session-import-budget-target");
	try {
		const bundlePath = path.join(source.root, "bundle");
		await exportEmptySession(source, "bundle-import-budget", bundlePath);
		const manifestPath = path.join(bundlePath, "manifest.json");
		const manifest = await Bun.file(manifestPath).json();
		manifest.sessionFile.byteLength =
			SESSION_BUNDLE_IMPORT_RESOURCE_BUDGETS.maxLogBytes + 1;
		await Bun.write(manifestPath, JSON.stringify(manifest));

		await expect(
			createSessionBundleImportOperation(target.store)({ bundlePath })
		).rejects.toMatchObject({ code: "session_bundle_invalid" });
		expect(await target.store.listSessions()).toEqual([]);
	} finally {
		await source.close();
		await target.close();
	}
});
