import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProviderCollection } from "@wincode/ai";
import { omitUndefined } from "@wincode/utils";
import { randomUUIDv7 } from "bun";
import { isAvailableProviderModelSelection } from "@/modules/providers/provider-model-selection";
import type { AttachmentReferenceResolver } from "@/modules/sessions/attachment-reference";
import { createValidatedPluginProviderCollectionForSelection } from "@/modules/sessions/host/agent-session-turn-runner";
import { ProviderCollectionUnavailableError } from "@/modules/sessions/provider-collection";
import {
	createSessionBundleExportOperation,
	SessionBundleExportError,
} from "@/modules/sessions/session-bundle-export";
import {
	createSessionBundleImportOperation,
	SessionBundleImportError,
} from "@/modules/sessions/session-bundle-import";
import {
	forkSessionThroughIdleHost,
	forkSessionThroughIdleHostAndThen,
} from "@/modules/sessions/session-fork-routing";
import { SessionLogError } from "@/modules/sessions/storage/session-jsonl-codec";
import {
	SessionForkError,
	SessionWriteOutcomeError,
} from "@/modules/sessions/storage/session-jsonl-store";
import { SessionPaginationError } from "@/modules/sessions/storage/session-pagination";
import { createSkillSnapshot } from "@/modules/skills";
import {
	isValidSessionId,
	type SessionId,
	toSessionId,
} from "@/shared/identifiers";
import { getErrorCode } from "@/shared/utils/error-log-fields";
import type {
	SessionHost,
	SessionSendInput,
	SessionWaitingMessageId,
} from "../../../modules/sessions/host/session-rpc";
import { resolveWorkspaceRoot as resolveSessionWorkspaceRoot } from "../../../modules/sessions/host/session-rpc";
import type { SessionFilePart } from "../../../modules/sessions/message";
import { projectMessage, submissionFromWaiting } from "./projection";
import {
	RPC_ERROR_CODES,
	type RpcRequest,
	type RpcResponse,
	success,
} from "./protocol";
import {
	DEFAULT_TRANSCRIPT_LIMIT,
	MAX_TRANSCRIPT_LIMIT,
	RPC_PROTOCOL_VERSION,
	RpcApplicationError,
	type RpcAssembly,
	type RpcCompositionInput,
	type RpcPreparedSubmission,
	RpcProtocolError,
	type RpcSessionState,
	type RpcSubmissionDraft,
	type RpcSubmissionIdentifiers,
	type RuntimeModules,
	SERVER_VERSION,
	SESSION_RPC_METHODS,
	type Selection,
} from "./types";
import {
	appError,
	asRecord,
	decodeCursor,
	encodeCursor,
	paramsOf,
	readSessionForkInput,
	readSessionPageOptions,
	readSessionStatisticsOptions,
	readSubmission,
	rpcInvalidParams,
	stringValue,
} from "./validation";

export type RpcRequestHandlerContext = Readonly<{
	bind: (host: SessionHost, sessionId: SessionId) => void;
	unbind: () => void;
	currentState: () => Record<string, unknown>;
	getRuntime: () => Promise<RuntimeModules>;
	parseSelection: (value: unknown) => Promise<Selection>;
	prepareSubmission: (
		draft: RpcSubmissionDraft
	) => Promise<RpcPreparedSubmission>;
	processId: string;
	providedComposer?: (input: RpcCompositionInput) => Promise<RpcAssembly>;
	requireBound: () => SessionHost;
	requireInitialized: () => void;
	sendInput: (
		selection: Selection,
		submission: RpcPreparedSubmission,
		ids: RpcSubmissionIdentifiers
	) => SessionSendInput;
	state: RpcSessionState;
}>;

const mapProviderCollectionUnavailableError = (
	error: unknown
): RpcApplicationError | undefined =>
	error instanceof ProviderCollectionUnavailableError
		? appError(
				"provider_sdk_required",
				"Connect the Provider in Interactive Mode before using RPC.",
				{ executionMode: "rpc", stage: "host" }
			)
		: undefined;

const mapSessionWriterError = (
	error: unknown,
	sessionId: string
): RpcApplicationError | undefined => {
	if (error instanceof SessionForkError) {
		return appError(error.code, error.message, {
			operationId: error.operationId,
			sourceSessionId: error.sourceSessionId,
		});
	}
	if (!(error instanceof Error)) {
		return;
	}
	const errorCode = getErrorCode(error);
	if (errorCode === "session_busy") {
		return appError("session_busy", error.message, { sessionId });
	}
	if (errorCode === "session_in_use") {
		return appError(
			"session_in_use",
			"Session is already in use by another Host."
		);
	}
	if (errorCode === "session_lock_failed") {
		return appError(
			"session_lock_failed",
			"The Session Writer OS lock could not be established.",
			{ sessionId, stage: "host" }
		);
	}
	if (error instanceof SessionWriteOutcomeError) {
		let code: string;
		switch (error.outcome.kind) {
			case "committed":
				code = "session_projection_unavailable";
				break;
			case "indeterminate":
				code = "session_commit_indeterminate";
				break;
			case "not-committed":
				if (error.outcome.error.code === "session_log_write_not_committed") {
					code = "session_commit_not_committed";
				} else {
					code = error.outcome.error.code;
				}
				break;
			default:
				code = "session_commit_unknown";
				break;
		}
		return appError(code, error.message, {
			operationId: error.outcome.operationId,
			outcome: error.outcome,
			sessionId,
		});
	}
	if (error instanceof SessionLogError) {
		const data = {
			offset: error.offset,
			operationId: error.operationId,
			sequence: error.sequence,
			sessionId: error.sessionId,
		};
		switch (error.code) {
			case "session_log_write_indeterminate":
				return appError("session_commit_indeterminate", error.message, data);
			case "session_log_write_not_committed":
				return appError("session_commit_not_committed", error.message, data);
			case "session_operation_conflict":
				return appError("session_operation_conflict", error.message, data);
			case "session_projection_blocked":
				return appError("session_projection_unavailable", error.message, data);
			case "session_deleted":
				return appError("session_deleted", error.message, data);
			case "session_not_found":
				return appError("session_not_found", error.message, data);
			case "session_log_corrupt":
			case "session_log_truncated":
				return appError("session_log_corrupt", error.message, data);
			case "session_log_version_unsupported":
				return appError("session_log_version_unsupported", error.message, data);
			default:
				return;
		}
	}
	return;
};

const mapSessionPaginationError = (
	error: unknown
): RpcApplicationError | undefined =>
	error instanceof SessionPaginationError
		? appError(error.code, error.message)
		: undefined;

const createAttachmentReferenceResolver = (
	attachmentStore: NonNullable<RpcAssembly["store"]>["attachmentStore"]
): AttachmentReferenceResolver | undefined => {
	if (attachmentStore === undefined) {
		return;
	}
	return {
		resolve: async (reference) => {
			const resolution = await attachmentStore.resolve(reference);
			if (resolution.availability !== "available") {
				return { availability: "unavailable" };
			}
			return {
				availability: "available",
				reference: resolution.reference,
			};
		},
	};
};

export const createRpcRequestHandler = (
	context: RpcRequestHandlerContext
): ((request: RpcRequest) => Promise<RpcResponse>) => {
	const {
		bind,
		unbind,
		currentState,
		getRuntime,
		parseSelection,
		prepareSubmission,
		processId,
		providedComposer,
		requireBound,
		requireInitialized,
		sendInput,
		state,
	} = context;
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The protocol method router intentionally centralizes lifecycle guards and response mapping.
	return async (request: RpcRequest): Promise<RpcResponse> => {
		if (request.method === "initialize") {
			if (state.lifecycle !== "uninitialized") {
				throw appError(
					"already_initialized",
					"The RPC server is already initialized."
				);
			}
			const params = paramsOf(request);
			if (
				params.protocolVersion !== RPC_PROTOCOL_VERSION ||
				!Number.isInteger(params.protocolVersion)
			) {
				throw appError(
					"unsupported_protocol_version",
					`Protocol version ${RPC_PROTOCOL_VERSION} is required.`
				);
			}
			const clientInfo = asRecord(params.clientInfo);
			if (
				clientInfo === undefined ||
				stringValue(clientInfo.name) === undefined
			) {
				throw rpcInvalidParams("clientInfo.name is required.");
			}
			if (
				clientInfo.version !== undefined &&
				typeof clientInfo.version !== "string"
			) {
				throw rpcInvalidParams("clientInfo.version must be a string.");
			}
			if (asRecord(params.capabilities) === undefined) {
				throw rpcInvalidParams("capabilities must be an object.");
			}
			const requestedCwd = params.cwd;
			if (typeof requestedCwd !== "string" || !path.isAbsolute(requestedCwd)) {
				throw appError(
					"workspace_unavailable",
					"initialize.cwd must be absolute."
				);
			}
			try {
				const info = await fs.stat(requestedCwd);
				if (!info.isDirectory()) {
					throw new Error("cwd is not a directory");
				}
			} catch {
				throw appError(
					"workspace_unavailable",
					"initialize.cwd is unavailable."
				);
			}
			let resolveWorkspaceRoot: (start: string) => string;
			let composer: (input: RpcCompositionInput) => Promise<RpcAssembly>;
			if (providedComposer === undefined) {
				const activeRuntime = await getRuntime();
				resolveWorkspaceRoot = activeRuntime.resolveWorkspaceRoot;
				composer = activeRuntime.openSessionServices;
			} else {
				resolveWorkspaceRoot = resolveSessionWorkspaceRoot;
				composer = providedComposer;
			}
			let workspace: string;
			try {
				workspace = resolveWorkspaceRoot(await fs.realpath(requestedCwd));
				workspace = await fs.realpath(workspace);
			} catch {
				throw appError(
					"workspace_unavailable",
					"Workspace could not be resolved."
				);
			}
			let composed: RpcAssembly;
			try {
				composed = await composer({
					cwd: requestedCwd,
					workspace,
				});
			} catch (error) {
				if (getErrorCode(error) === "session_lock_failed") {
					throw appError(
						"session_lock_failed",
						"The Session Writer OS lock could not be established."
					);
				}
				throw appError(
					"workspace_unavailable",
					"Workspace capabilities could not be composed."
				);
			}
			if (state.signalRequested || state.lifecycle !== "uninitialized") {
				await composed.shutdown().catch(() => undefined);
				throw appError("server_closing", "The RPC server is closing.");
			}
			state.assembly = composed;
			state.lifecycle = "initialized";
			return success(request.id, {
				capabilities: {
					explicitSteering: true,
					failedSubmissionRetry: true,
					stateNotifications: true,
					structuredSubmissions: true,
					submissionEvents: true,
					sessionCatalogPagination: true,
					sessionHistoryPagination: true,
					sessionHistoryNavigation: true,
					sessionStatistics: true,
					sessionBundleExport: true,
					sessionBundleImport: true,
					sessionFork: true,
					sessionRewind: true,
					transcriptPagination: true,
				},
				protocolVersion: RPC_PROTOCOL_VERSION,
				serverInfo: { name: "wincode", version: SERVER_VERSION },
				workspace: {
					id: state.assembly.workspaceId,
					root: state.assembly.workspace,
				},
			});
		}
		if (request.method === "server/shutdown") {
			state.shutdownRequested = true;
			return success(request.id, { shutdown: true });
		}
		if (!SESSION_RPC_METHODS.has(request.method)) {
			throw new RpcProtocolError(
				RPC_ERROR_CODES.methodNotFound,
				"Method not found"
			);
		}
		requireInitialized();
		if (request.method === "session/listPage") {
			const store = state.assembly?.store;
			if (store === undefined) {
				throw appError("not_initialized", "Session storage is unavailable.");
			}
			const pageOptions = readSessionPageOptions(paramsOf(request));
			try {
				return success(request.id, await store.listSessionsPage(pageOptions));
			} catch (error) {
				const paginationError = mapSessionPaginationError(error);
				if (paginationError !== undefined) {
					throw paginationError;
				}
				throw error;
			}
		}
		if (request.method === "session/getHistoryPage") {
			const store = state.assembly?.store;
			if (store === undefined) {
				throw appError("not_initialized", "Session storage is unavailable.");
			}
			const params = paramsOf(request);
			const pageOptions = readSessionPageOptions(params, ["sessionId"]);
			const sessionIdValue = stringValue(params.sessionId);
			if (sessionIdValue === undefined || !isValidSessionId(sessionIdValue)) {
				throw rpcInvalidParams("sessionId must be a valid Session ID.");
			}
			const sessionId = toSessionId(sessionIdValue);
			try {
				return success(
					request.id,
					await store.readSessionHistoryPage(sessionId, pageOptions)
				);
			} catch (error) {
				const paginationError = mapSessionPaginationError(error);
				if (paginationError !== undefined) {
					throw paginationError;
				}
				const writerError = mapSessionWriterError(error, sessionId);
				if (writerError !== undefined) {
					throw writerError;
				}
				throw error;
			}
		}
		if (request.method === "session/navigateHistory") {
			const assembly = state.assembly;
			if (assembly?.store === undefined) {
				throw appError("not_initialized", "Session storage is unavailable.");
			}
			const params = paramsOf(request);
			const sessionIdValue = stringValue(params.sessionId);
			const operationId = stringValue(params.operationId);
			const targetValue = params.targetEntryId;
			const targetEntryId =
				targetValue === null ? null : stringValue(targetValue);
			if (sessionIdValue === undefined || !isValidSessionId(sessionIdValue)) {
				throw rpcInvalidParams("sessionId must be a valid Session ID.");
			}
			if (operationId === undefined || operationId.length === 0) {
				throw rpcInvalidParams("operationId must be a non-empty string.");
			}
			if (targetEntryId === undefined) {
				throw rpcInvalidParams(
					"targetEntryId must be a history entry ID or null."
				);
			}
			const sessionId = toSessionId(sessionIdValue);
			if (state.boundSessionId !== sessionId) {
				throw appError(
					"session_not_open",
					"Open the target Session before navigating its history.",
					{ sessionId }
				);
			}
			const activeHost = requireBound();
			try {
				const outcome = await assembly.capabilities
					.getSessionHostManager()
					.withIdleForSessionNavigation(
						sessionId,
						targetEntryId,
						operationId,
						async (idleHost) =>
							idleHost === activeHost
								? idleHost.navigateHistory(targetEntryId, operationId)
								: {
										kind: "rejected",
										code: "session_host_changed",
										reason: "Session Host is no longer open.",
									}
					);
				return success(request.id, outcome);
			} catch (error) {
				const writerError = mapSessionWriterError(error, sessionId);
				if (writerError !== undefined) {
					throw writerError;
				}
				throw error;
			}
		}
		if (request.method === "session/getStatistics") {
			const store = state.assembly?.store;
			if (store === undefined) {
				throw appError("not_initialized", "Session storage is unavailable.");
			}
			const params = paramsOf(request);
			const statisticsOptions = readSessionStatisticsOptions(params, [
				"sessionId",
			]);
			const sessionIdValue = stringValue(params.sessionId);
			if (sessionIdValue === undefined || !isValidSessionId(sessionIdValue)) {
				throw rpcInvalidParams("sessionId must be a valid Session ID.");
			}
			const sessionId = toSessionId(sessionIdValue);
			try {
				return success(
					request.id,
					await store.getSessionStatistics(sessionId, statisticsOptions)
				);
			} catch (error) {
				const paginationError = mapSessionPaginationError(error);
				if (paginationError !== undefined) {
					throw paginationError;
				}
				const writerError = mapSessionWriterError(error, sessionId);
				if (writerError !== undefined) {
					throw writerError;
				}
				throw error;
			}
		}
		if (request.method === "session/exportBundle") {
			const assembly = state.assembly;
			const store = assembly?.store;
			if (assembly === undefined || store === undefined) {
				throw appError("not_initialized", "Session storage is unavailable.");
			}
			const params = paramsOf(request);
			const sessionIdValue = stringValue(params.sessionId);
			const destination = stringValue(params.destination);
			if (sessionIdValue === undefined || !isValidSessionId(sessionIdValue)) {
				throw rpcInvalidParams("sessionId must be a valid Session ID.");
			}
			if (destination === undefined || destination.trim().length === 0) {
				throw rpcInvalidParams(
					"destination must be a non-empty directory path."
				);
			}
			const sessionId = toSessionId(sessionIdValue);
			const exportSessionBundle = createSessionBundleExportOperation(
				assembly.capabilities.getSessionHostManager(),
				store
			);
			try {
				return success(
					request.id,
					await exportSessionBundle({
						destination,
						sessionId,
						sourceWorkspacePath: assembly.workspace,
					})
				);
			} catch (error) {
				if (error instanceof SessionBundleExportError) {
					throw appError(error.code, error.message, {
						sessionId,
						...(error.code === "session_log_corrupt" ||
						error.code === "session_log_version_unsupported"
							? omitUndefined({
									offset: error.offset,
									reason: error.reason,
									sequence: error.sequence,
								})
							: {}),
					});
				}
				throw error;
			}
		}
		if (request.method === "session/importBundle") {
			const assembly = state.assembly;
			const store = assembly?.store;
			if (assembly === undefined || store === undefined) {
				throw appError("not_initialized", "Session storage is unavailable.");
			}
			const bundlePath = stringValue(paramsOf(request).bundlePath);
			if (bundlePath === undefined || bundlePath.trim().length === 0) {
				throw rpcInvalidParams(
					"bundlePath must be a non-empty directory path."
				);
			}
			const importSessionBundle = createSessionBundleImportOperation(store);
			try {
				return success(request.id, await importSessionBundle({ bundlePath }));
			} catch (error) {
				if (error instanceof SessionBundleImportError) {
					throw appError(
						error.code,
						error.message,
						omitUndefined({ sessionId: error.sessionId })
					);
				}
				throw error;
			}
		}
		if (
			request.method === "session/fork" ||
			request.method === "session/rewind"
		) {
			const activeAssembly = state.assembly;
			if (activeAssembly?.store === undefined) {
				throw appError("not_initialized", "Session storage is unavailable.");
			}
			const store = activeAssembly.store;
			const runtime = await getRuntime();
			const input = readSessionForkInput(paramsOf(request));
			const sourceSessionId = runtime.toSessionId(input.sourceSessionId);
			const checkpoint = {
				recordId: runtime.toSessionRecordId(input.checkpointRecordId),
			};
			try {
				const manager = activeAssembly.capabilities.getSessionHostManager();
				if (request.method === "session/fork") {
					const result = await forkSessionThroughIdleHost(
						manager.withIdleForSessionFork,
						store,
						sourceSessionId,
						checkpoint,
						input.operationId
					);
					return success(request.id, result);
				}

				return await forkSessionThroughIdleHostAndThen(
					manager.withIdleForSessionFork,
					store,
					sourceSessionId,
					checkpoint,
					input.operationId,
					async (result) => {
						const targetSessionId = runtime.toSessionId(String(result.id));
						let targetHost: SessionHost | undefined;
						try {
							targetHost = await runtime.createSessionHost({
								capabilities: activeAssembly.capabilities,
								sessionId: targetSessionId,
							});
							if (
								state.signalRequested ||
								state.lifecycle === "closing" ||
								state.lifecycle === "closed"
							) {
								await manager
									.releaseView(targetSessionId)
									.catch(() => undefined);
								targetHost = undefined;
								throw appError("server_closing", "The RPC server is closing.");
							}
							bind(targetHost, targetSessionId);
							return success(request.id, {
								...result,
								activeSessionId: targetSessionId,
								state: currentState(),
							});
						} catch (error) {
							if (
								targetHost !== undefined &&
								state.boundSessionId !== targetSessionId
							) {
								await manager
									.releaseView(targetSessionId)
									.catch(() => undefined);
							}
							throw error;
						}
					}
				);
			} catch (error) {
				const writerError = mapSessionWriterError(error, sourceSessionId);
				if (writerError !== undefined) {
					throw writerError;
				}
				throw error;
			}
		}
		if (request.method === "session/create") {
			if (state.assembly === undefined || state.assembly.store === undefined) {
				throw appError(
					"not_initialized",
					"Initialize before creating a Session."
				);
			}
			const activeAssembly = state.assembly;
			const activeRuntime = await getRuntime();
			if (activeAssembly.store === undefined) {
				throw appError("not_initialized", "Session storage is unavailable.");
			}
			const store = activeAssembly.store;
			const params = paramsOf(request);
			if (params.selection === undefined) {
				throw appError(
					"selection_required",
					"Session creation requires a Selection."
				);
			}
			const selection = await parseSelection(params.selection);
			const plannedSessionId = activeRuntime.toSessionId(randomUUIDv7());
			let providerCollection: ProviderCollection;
			try {
				providerCollection =
					await createValidatedPluginProviderCollectionForSelection(
						selection.model,
						activeAssembly.capabilities,
						plannedSessionId,
						[selection.model.providerId]
					);
			} catch (error) {
				const providerError = mapProviderCollectionUnavailableError(error);
				if (providerError !== undefined) {
					throw providerError;
				}
				throw rpcInvalidParams(
					error instanceof Error
						? error.message
						: "Plugin Provider ownership could not be validated."
				);
			}
			let providerCollectionTransferred = false;
			try {
				await providerCollection.restoreModels();
				const availableProviderModels = await providerCollection.getAvailable(
					selection.model.providerId
				);
				if (
					!isAvailableProviderModelSelection(
						selection.model,
						availableProviderModels
					)
				) {
					throw rpcInvalidParams(
						`Provider Model ${selection.model.providerId}/${selection.model.modelId} is unavailable in this RPC Host.`
					);
				}
				const draft = await readSubmission(
					params,
					"initialSubmission",
					createAttachmentReferenceResolver(store.attachmentStore)
				);
				const submission = await prepareSubmission(draft);
				const turnId = activeRuntime.createAgentTurnId();
				const baseMessage = activeRuntime.createSessionUserMessage(
					submission.userText,
					{
						agent: selection.agentId as SessionSendInput["agent"],
						model: selection.model,
						...(selection.thinkingLevel === undefined
							? {}
							: { thinkingLevel: selection.thinkingLevel }),
						...(submission.skill === undefined
							? {}
							: { skill: createSkillSnapshot(submission.skill, "explicit") }),
					}
				);
				const initialMessage = {
					...baseMessage,
					parts: [...baseMessage.parts, ...submission.files],
				};
				const created = await store.createSessionWithExternalizedMessage({
					id: plannedSessionId,
					agent: selection.agentId as SessionSendInput["agent"],
					message: initialMessage,
					model: selection.model,
					turnId,
					...(selection.thinkingLevel === undefined
						? {}
						: { thinkingLevel: selection.thinkingLevel }),
				});
				const message = created.message;
				const messageFiles = message.parts.filter(
					(part): part is SessionFilePart => part.type === "file"
				);
				const storedSubmission: RpcPreparedSubmission = {
					...submission,
					composition: { ...submission.composition, files: messageFiles },
					files: messageFiles,
				};
				if (
					created.writeOutcome.kind !== "committed" ||
					created.writeOutcome.projection !== "ready"
				) {
					const writeError = new SessionWriteOutcomeError(created.writeOutcome);
					throw (
						mapSessionWriterError(writeError, String(created.id)) ?? writeError
					);
				}
				const createdId = activeRuntime.toSessionId(String(created.id));
				const previousSessionId = state.boundSessionId;
				const manager = activeAssembly.capabilities.getSessionHostManager();
				const restorePreviousBinding = async (): Promise<void> => {
					if (previousSessionId === undefined || state.signalRequested) {
						return;
					}
					const restoredHost = await activeRuntime.createSessionHost({
						capabilities: activeAssembly.capabilities,
						sessionId: previousSessionId,
					});
					bind(restoredHost, previousSessionId);
				};
				let createdHost: SessionHost | undefined;
				try {
					providerCollectionTransferred = true;
					createdHost = await activeRuntime.createSessionHost({
						capabilities: activeAssembly.capabilities,
						providerCollection,
						providerModel: selection.model,
						sessionId: createdId,
					});
					if (
						state.signalRequested ||
						(state.lifecycle !== "initialized" && state.lifecycle !== "bound")
					) {
						await manager.releaseView(createdId).catch(() => undefined);
						createdHost = undefined;
						throw appError("server_closing", "The RPC server is closing.");
					}
					bind(createdHost, createdId);
					const admission = await state.host?.agentSession.prompt(
						sendInput(selection, storedSubmission, {
							messageId: message.id,
							turnId,
						})
					);
					if (admission === undefined || admission.rejected) {
						unbind();
						createdHost = undefined;
						await restorePreviousBinding();
						throw appError(
							"session_created_but_unbound",
							"Session admission failed after creation.",
							{
								sessionId: createdId,
								stage: "admission",
							}
						);
					}
					return success(request.id, {
						admission,
						sessionId: createdId,
						state: currentState(),
					});
				} catch (error) {
					if (createdHost !== undefined) {
						const failedHost = createdHost;
						createdHost = undefined;
						if (state.host === failedHost) {
							unbind();
							await restorePreviousBinding();
						} else {
							await manager.releaseView(createdId).catch(() => undefined);
						}
					}
					if (error instanceof RpcApplicationError) {
						throw error;
					}
					const providerError = mapProviderCollectionUnavailableError(error);
					if (providerError !== undefined) {
						throw providerError;
					}
					const writerError = mapSessionWriterError(error, createdId);
					if (writerError !== undefined) {
						throw writerError;
					}
					throw appError(
						"session_created_but_unbound",
						"Session Host could not be opened.",
						{
							sessionId: createdId,
							stage: "host",
						}
					);
				}
			} finally {
				if (!providerCollectionTransferred) {
					await providerCollection.close().catch(() => undefined);
				}
			}
		}
		if (request.method === "session/open") {
			if (state.assembly === undefined || state.assembly.store === undefined) {
				throw appError(
					"not_initialized",
					"Initialize before opening a Session."
				);
			}
			const activeAssembly = state.assembly;
			const activeRuntime = await getRuntime();
			if (activeAssembly.store === undefined) {
				throw appError("not_initialized", "Session storage is unavailable.");
			}
			const store = activeAssembly.store;
			const requestedSessionId = stringValue(paramsOf(request).sessionId);
			if (requestedSessionId === undefined) {
				throw rpcInvalidParams("sessionId is required.");
			}
			const sessionId = activeRuntime.toSessionId(requestedSessionId);
			try {
				await store.getSession(sessionId);
			} catch (error) {
				if (error instanceof Error && error.message === "Session not found") {
					throw appError(
						"session_not_found",
						"Session was not found in this Workspace."
					);
				}
				const storageError = mapSessionWriterError(error, sessionId);
				if (storageError !== undefined) {
					throw storageError;
				}
				throw error;
			}
			try {
				const openedHost = await activeRuntime.createSessionHost({
					capabilities: activeAssembly.capabilities,
					sessionId,
				});
				if (
					state.signalRequested ||
					(state.lifecycle !== "initialized" && state.lifecycle !== "bound")
				) {
					await activeAssembly.capabilities
						.getSessionHostManager()
						.releaseView(sessionId)
						.catch(() => undefined);
					throw appError("server_closing", "The RPC server is closing.");
				}
				bind(openedHost, sessionId);
				return success(request.id, { sessionId, state: currentState() });
			} catch (error) {
				const providerError = mapProviderCollectionUnavailableError(error);
				if (providerError !== undefined) {
					throw providerError;
				}
				const writerError = mapSessionWriterError(error, sessionId);
				if (writerError !== undefined) {
					throw writerError;
				}
				if (error instanceof Error && error.message === "Session not found") {
					throw appError("session_not_found", "Session could not be opened.");
				}
				throw error;
			}
		}
		if (request.method === "session/getState") {
			return success(request.id, currentState());
		}
		if (request.method === "session/submit") {
			const activeHost = requireBound();
			const params = paramsOf(request);
			const draft = await readSubmission(
				params,
				"submission",
				createAttachmentReferenceResolver(
					state.assembly?.store?.attachmentStore
				)
			);
			const submission = await prepareSubmission(draft);
			const selection =
				params.selection === undefined
					? await (async () => {
							const active = activeHost.getSelection();
							if (active === null || active.agent === undefined) {
								throw appError(
									"selection_required",
									"A Session Selection is required."
								);
							}
							return parseSelection({
								agentId: active.agent,
								model: active.model,
								...(active.thinkingLevel === undefined
									? {}
									: { thinkingLevel: active.thinkingLevel }),
							});
						})()
					: await parseSelection(params.selection);
			const admission = await activeHost.agentSession.prompt(
				sendInput(selection, submission, {})
			);
			if (admission.rejected) {
				throw appError("submission_rejected", admission.reason);
			}
			return success(request.id, admission);
		}
		if (request.method === "session/steer") {
			if (Object.keys(paramsOf(request)).length > 0) {
				throw rpcInvalidParams("session/steer does not accept parameters.");
			}
			const outcome = await requireBound().agentSession.steer();
			return success(request.id, outcome);
		}
		if (request.method === "session/retry") {
			const activeHost = requireBound();
			const params = paramsOf(request);
			const submissionId = stringValue(params.submissionId);
			if (submissionId === undefined || Object.keys(params).length !== 1) {
				throw rpcInvalidParams(
					"session/retry requires exactly one submissionId."
				);
			}
			const snapshot = activeHost.getSnapshot();
			const failed = snapshot.steeringMessages[0];
			if (
				failed === undefined ||
				failed.status !== "failed" ||
				failed.input.submissionId !== submissionId ||
				snapshot.turnActive ||
				snapshot.isCompacting
			) {
				throw appError(
					"submission_not_retryable",
					"Only the failed head Submission can be retried while the Session is idle."
				);
			}
			const started = Promise.withResolvers<void>();
			const unsubscribe = activeHost.agentSession.onSubmissionEvent((event) => {
				if (
					event.kind === "started" &&
					event.messageId === failed.message.id &&
					event.submissionId === submissionId
				) {
					started.resolve();
				}
			});
			try {
				const retry = activeHost.agentSession.send(failed.input).then(
					(outcome) => ({ kind: "outcome" as const, outcome }),
					(error: unknown) => ({ error, kind: "error" as const })
				);
				const result = await Promise.race([
					started.promise.then(() => ({ kind: "started" as const })),
					retry,
				]);
				if (result.kind === "error") {
					throw appError(
						"submission_retry_failed",
						result.error instanceof Error
							? result.error.message
							: "The committed Submission could not be retried."
					);
				}
				if (result.kind === "outcome" && result.outcome.rejected) {
					throw appError("submission_retry_failed", result.outcome.reason);
				}
				return success(request.id, {
					kind: "retrying",
					messageId: failed.message.id,
					submissionId,
				});
			} finally {
				unsubscribe();
			}
		}
		if (request.method === "session/interrupt") {
			const activeHost = requireBound();
			const result = await activeHost.agentSession.interruptAll();
			return success(request.id, {
				recalled: result.recalled.map(submissionFromWaiting),
				stopped: result.kind,
			});
		}
		if (request.method === "session/recall") {
			const activeHost = requireBound();
			const value = paramsOf(request).submissionIds;
			const isStringArray = (candidate: unknown): candidate is string[] =>
				Array.isArray(candidate) &&
				candidate.every(
					(id: unknown) => typeof id === "string" && id.length > 0
				);
			if (value !== undefined && !isStringArray(value)) {
				throw rpcInvalidParams("submissionIds must be unique strings.");
			}
			const ids = value as string[] | undefined;
			if (ids !== undefined && new Set(ids).size !== ids.length) {
				throw rpcInvalidParams("submissionIds must be unique.");
			}
			const recalled = await activeHost.agentSession.recallWaitingMessages(
				ids as SessionWaitingMessageId[] | undefined
			);
			return success(request.id, {
				recalled: recalled.map(submissionFromWaiting),
			});
		}
		if (request.method === "session/getTranscript") {
			const activeHost = requireBound();
			const params = paramsOf(request);
			const limitValue = params.limit;
			if (
				limitValue !== undefined &&
				(typeof limitValue !== "number" ||
					!Number.isInteger(limitValue) ||
					limitValue < 1 ||
					limitValue > MAX_TRANSCRIPT_LIMIT)
			) {
				throw rpcInvalidParams("limit must be an integer from 1 to 500.");
			}
			const limit =
				limitValue === undefined
					? DEFAULT_TRANSCRIPT_LIMIT
					: (limitValue as number);
			const snapshot = activeHost.getSnapshot();
			const revision = currentState().transcript as {
				revision: number;
				messageCount: number;
			};
			let position = 0;
			const cursorValue = params.cursor;
			if (cursorValue !== undefined) {
				if (typeof cursorValue !== "string") {
					throw appError(
						"transcript_cursor_stale",
						"Transcript cursor is invalid."
					);
				}
				const cursor = decodeCursor(cursorValue);
				const cursorPosition = cursor.position;
				if (
					cursor.processId !== processId ||
					cursor.sessionId !== state.boundSessionId ||
					cursor.revision !== revision.revision ||
					typeof cursorPosition !== "number" ||
					!Number.isInteger(cursorPosition) ||
					cursorPosition < 0 ||
					cursorPosition > snapshot.transcript.length
				) {
					throw appError(
						"transcript_cursor_stale",
						"Transcript cursor is stale."
					);
				}
				position = cursorPosition;
			}
			const messages = snapshot.transcript
				.slice(position, position + limit)
				.map(projectMessage);
			const nextPosition = position + messages.length;
			return success(request.id, {
				messages,
				nextCursor:
					nextPosition < snapshot.transcript.length
						? encodeCursor({
								position: nextPosition,
								revision: revision.revision,
								sessionId: state.boundSessionId as string,
								processId,
							})
						: undefined,
				revision: revision.revision,
			});
		}
		throw new RpcProtocolError(
			RPC_ERROR_CODES.methodNotFound,
			"Method not found"
		);
	};
};
