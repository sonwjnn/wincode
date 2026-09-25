import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
	SessionHost,
	SessionSendInput,
	SessionWaitingMessageId,
} from "../../../modules/sessions/host/session-rpc";
import { resolveWorkspaceRoot as resolveSessionWorkspaceRoot } from "../../../modules/sessions/host/session-rpc";
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
	RpcApplicationError,
	type RpcAssembly,
	type RpcCompositionInput,
	RpcProtocolError,
	type RpcSessionState,
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
	readTextSubmission,
	rpcInvalidParams,
	stringValue,
} from "./validation";

export type RpcRequestHandlerContext = Readonly<{
	autoApproval?: boolean;
	bind: (host: SessionHost, sessionId: string) => void;
	currentState: () => Record<string, unknown>;
	getRuntime: () => Promise<RuntimeModules>;
	parseSelection: (value: unknown) => Promise<Selection>;
	processId: string;
	providedComposer?: (input: RpcCompositionInput) => Promise<RpcAssembly>;
	requireBound: () => SessionHost;
	requireInitialized: () => void;
	resolveApprovalId: (wireApprovalId: string) => string | undefined;
	sendInput: (
		selection: Selection,
		text: string,
		ids: { messageId?: string; submissionId?: string; turnId?: string }
	) => SessionSendInput;
	state: RpcSessionState;
}>;

export const createRpcRequestHandler = (
	context: RpcRequestHandlerContext
): ((request: RpcRequest) => Promise<RpcResponse>) => {
	const {
		autoApproval,
		bind,
		currentState,
		getRuntime,
		parseSelection,
		processId,
		providedComposer,
		requireBound,
		requireInitialized,
		resolveApprovalId,
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
				params.protocolVersion !== 1 ||
				!Number.isInteger(params.protocolVersion)
			) {
				throw appError(
					"unsupported_protocol_version",
					"Protocol version 1 is required."
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
				const info = await stat(requestedCwd);
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
				composer = activeRuntime.createSessionCapabilities;
			} else {
				resolveWorkspaceRoot = resolveSessionWorkspaceRoot;
				composer = providedComposer;
			}
			let workspace: string;
			try {
				workspace = resolveWorkspaceRoot(await realpath(requestedCwd));
				workspace = await realpath(workspace);
			} catch {
				throw appError(
					"workspace_unavailable",
					"Workspace could not be resolved."
				);
			}
			let composed: RpcAssembly;
			try {
				composed = await composer({
					autoApproval,
					cwd: requestedCwd,
					workspace,
				});
			} catch {
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
					approvalResponses: true,
					stateNotifications: true,
					submissionEvents: true,
					transcriptPagination: true,
				},
				protocolVersion: 1,
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
		if (request.method === "session/create") {
			if (state.lifecycle === "bound") {
				throw appError(
					"session_already_bound",
					"This process already owns a Session."
				);
			}
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
			const text = readTextSubmission(params, "initialSubmission");
			const turnId = activeRuntime.createAgentTurnId();
			const message = activeRuntime.createSessionUserMessage(text, {
				agent: selection.agentId as SessionSendInput["agent"],
				model: selection.model,
				...(selection.variant === undefined
					? {}
					: { variant: selection.variant }),
			});
			const created = await store.createSession({
				agent: selection.agentId as SessionSendInput["agent"],
				message,
				model: selection.model,
				turnId,
				...(selection.variant === undefined
					? {}
					: { variant: selection.variant }),
			});
			const createdId = activeRuntime.toSessionId(String(created.id));
			let createdHost: SessionHost | undefined;
			try {
				createdHost = await activeRuntime.createSessionHost({
					capabilities: activeAssembly.capabilities,
					sessionId: createdId,
				});
				if (state.signalRequested || state.lifecycle !== "initialized") {
					await createdHost.shutdown().catch(() => undefined);
					createdHost = undefined;
					throw appError("server_closing", "The RPC server is closing.");
				}
				bind(createdHost, createdId);
				const admission = await state.host?.agentSession.prompt(
					sendInput(selection, text, {
						messageId: message.id,
						turnId,
					})
				);
				if (admission === undefined || admission.rejected) {
					const failedHost = state.host;
					state.host = undefined;
					state.boundSessionId = undefined;
					state.lifecycle = "initialized";
					createdHost = undefined;
					await failedHost?.shutdown().catch(() => undefined);
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
						state.host = undefined;
						state.boundSessionId = undefined;
						state.lifecycle = "initialized";
					}
					await failedHost.shutdown().catch(() => undefined);
				}
				if (error instanceof RpcApplicationError) {
					throw error;
				}
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "session_lease_lost"
				) {
					throw appError(
						"session_lease_lost",
						"Session lease was lost while opening the Host."
					);
				}
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "session_in_use"
				) {
					throw appError(
						"session_in_use",
						"Session is already owned by another Host."
					);
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
		}
		if (request.method === "session/open") {
			if (state.lifecycle === "bound") {
				throw appError(
					"session_already_bound",
					"This process already owns a Session."
				);
			}
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
				throw error;
			}
			try {
				const openedHost = await activeRuntime.createSessionHost({
					capabilities: activeAssembly.capabilities,
					sessionId,
				});
				if (state.signalRequested || state.lifecycle !== "initialized") {
					await openedHost.shutdown().catch(() => undefined);
					throw appError("server_closing", "The RPC server is closing.");
				}
				bind(openedHost, sessionId);
				return success(request.id, { sessionId, state: currentState() });
			} catch (error) {
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "session_lease_lost"
				) {
					throw appError(
						"session_lease_lost",
						"Session lease was lost while opening the Host."
					);
				}
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "session_in_use"
				) {
					throw appError(
						"session_in_use",
						"Session is already owned by another Host."
					);
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
			const text = readTextSubmission(params, "submission");
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
								...(active.variant === undefined
									? {}
									: { variant: active.variant }),
							});
						})()
					: await parseSelection(params.selection);
			const steering = activeHost.getSnapshot().turnActive
				? activeHost.agentSession.steer(text)
				: undefined;
			const admission =
				steering === undefined || steering.rejected
					? await activeHost.agentSession.prompt(sendInput(selection, text, {}))
					: steering;
			if (admission.rejected) {
				throw appError("submission_rejected", admission.reason);
			}
			return success(request.id, admission);
		}
		if (request.method === "session/interrupt") {
			const activeHost = requireBound();
			const result = activeHost.agentSession.interruptAll();
			return success(request.id, {
				recalled: result.recalled.map(submissionFromWaiting),
				settledApprovals: result.approvalsSettled,
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
			const recalled = activeHost.agentSession.recallWaitingMessages(
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
		if (request.method === "session/respondToApproval") {
			const activeHost = requireBound();
			const params = paramsOf(request);
			const wireApprovalId = stringValue(params.approvalId);
			if (wireApprovalId === undefined) {
				throw rpcInvalidParams("approvalId is required.");
			}
			const approvalId = resolveApprovalId(wireApprovalId);
			if (approvalId === undefined) {
				return success(request.id, { applied: false });
			}
			if (params.decision === "allowOnce") {
				const result = activeHost.agentSession.respondToApproval(approvalId, {
					decision: "allow",
					remember: false,
				});
				return success(request.id, { applied: result.applied });
			}
			if (params.decision === "alwaysAllow") {
				const result = activeHost.agentSession.respondToApproval(approvalId, {
					decision: "allow",
					remember: true,
				});
				if (!result.applied && result.reason === "persistence-forbidden") {
					throw appError(
						"approval_persistence_forbidden",
						"This approval cannot be persisted."
					);
				}
				return success(request.id, { applied: result.applied });
			}
			if (params.decision === "reject") {
				if (
					params.feedback !== undefined &&
					typeof params.feedback !== "string"
				) {
					throw rpcInvalidParams("feedback must be a string.");
				}
				const result = activeHost.agentSession.respondToApproval(approvalId, {
					decision: "reject",
					...(params.feedback === undefined
						? {}
						: { feedback: params.feedback }),
				});
				return success(request.id, { applied: result.applied });
			}
			if (params.decision === "abort") {
				const result = activeHost.agentSession.respondToApproval(approvalId, {
					decision: "abort",
				});
				return success(request.id, { applied: result.applied });
			}
			throw rpcInvalidParams("Unknown approval decision.");
		}
		throw new RpcProtocolError(
			RPC_ERROR_CODES.methodNotFound,
			"Method not found"
		);
	};
};
