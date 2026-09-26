import { randomUUID } from "node:crypto";
import { logger } from "@wincode/runtime-utils";
import type {
	SessionHost,
	SessionSnapshot,
	SessionSubmissionEvent,
} from "../../../modules/sessions/host/session-rpc";
import { type DeferredNotification, SerializedWriter } from "./output";
import {
	operationalStatus,
	projectAgentEvent,
	projectApproval,
	projectExecution,
	projectMessage,
	projectQueued,
	projectSteering,
	projectSubmissionEvent,
	selectionFromHost,
} from "./projection";
import {
	failure,
	JSON_RPC_VERSION,
	parseRpcRequest,
	RPC_ERROR_CODES,
	type RpcResponse,
	readJsonl,
} from "./protocol";
import { createRpcRequestHandler } from "./request-handler";
import { loadRuntime } from "./runtime";
import { createSelectionHelpers } from "./selection";
import {
	APPLICATION_ERROR_CODE,
	MAX_OUTPUT_BYTES,
	RpcApplicationError,
	RpcOutputOverflowError,
	RpcProtocolError,
	type RpcRunnerOptions,
	type RpcSessionState,
	type RuntimeModules,
} from "./types";
import { appError, asRecord, stringValue } from "./validation";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This controller owns the JSONL lifecycle, output ordering, and teardown boundary.
export async function runRpc({
	autoApproval,
	composeCapabilities: providedComposer,
	input,
	signal,
	signalExitCode,
	stderr,
	stdout,
}: RpcRunnerOptions): Promise<number> {
	const output = new SerializedWriter(stdout);
	const inputAbortController = new AbortController();
	const inputSignal =
		signal === undefined
			? inputAbortController.signal
			: AbortSignal.any([signal, inputAbortController.signal]);
	let stopOutputError: (() => void) | undefined;
	const detachOutputError = (): void => {
		stopOutputError?.();
		stopOutputError = undefined;
	};
	const processId = randomUUID();
	const seenRequestIds = new Set<string>();
	const approvalWireIds = new WeakMap<
		SessionSnapshot["approvals"][number],
		string
	>();
	const approvalEngineIdsByWire = new Map<string, string>();
	const activeApprovalWireIds = new Map<string, string>();
	const wireApprovalId = (
		approval: SessionSnapshot["approvals"][number]
	): string => {
		const existing = approvalWireIds.get(approval);
		if (existing !== undefined) {
			return existing;
		}
		const previousWireId = activeApprovalWireIds.get(approval.id);
		if (previousWireId !== undefined) {
			approvalEngineIdsByWire.delete(previousWireId);
		}
		const wireId = `approval-${randomUUID()}`;
		approvalWireIds.set(approval, wireId);
		activeApprovalWireIds.set(approval.id, wireId);
		approvalEngineIdsByWire.set(wireId, approval.id);
		return wireId;
	};
	const retireSettledApprovalWireIds = (
		pendingApprovalIds: ReadonlySet<string>
	): void => {
		for (const [engineApprovalId, wireId] of activeApprovalWireIds) {
			if (!pendingApprovalIds.has(engineApprovalId)) {
				activeApprovalWireIds.delete(engineApprovalId);
				approvalEngineIdsByWire.delete(wireId);
			}
		}
	};
	const deferred: Array<DeferredNotification | undefined> = [];
	let deferredHead = 0;
	let deferredBytes = 0;
	let deferredOverflow = false;
	const unsubscribers: Array<() => void> = [];
	let runtime: RuntimeModules | undefined;
	const state: RpcSessionState = {
		lifecycle: "uninitialized",
		shutdownRequested: false,
		signalRequested: false,
	};
	let handlingRequest = false;
	let requestedExitCode: number | undefined;
	const abortRequested = Promise.withResolvers<void>();
	let fatal = false;
	let fatalPromise: Promise<void> | undefined;
	let notificationSequence = 0;
	let stateRevision = 0;
	let transcriptRevision = 0;
	let lastStateSignature = "";
	let lastTranscriptSignature = "";
	let lastState: Record<string, unknown> | undefined;
	const getRuntime = async (): Promise<RuntimeModules> => {
		if (runtime === undefined) {
			runtime = await loadRuntime();
		}
		return runtime;
	};

	const writeStderrDiagnostic = (message: string): void => {
		stderr.write(`${message}\n`);
	};
	const onAbort = (): void => {
		state.signalRequested = true;
		requestedExitCode =
			typeof signalExitCode === "function"
				? signalExitCode()
				: (signalExitCode ?? 1);
		state.shutdownRequested = true;
		abortRequested.resolve();
	};

	const cleanup = (() => {
		let cleanupPromise: Promise<void> | undefined;
		return (): Promise<void> => {
			if (cleanupPromise !== undefined) {
				return cleanupPromise;
			}
			cleanupPromise = (async (): Promise<void> => {
				if (state.lifecycle === "closed") {
					return;
				}
				state.lifecycle = "closing";
				inputAbortController.abort();
				const deadline = Date.now() + 5000;
				const settle = async (
					work: Promise<void>,
					label: string
				): Promise<void> => {
					const remaining = Math.max(0, deadline - Date.now());
					if (remaining === 0) {
						void logger.warn("RPC shutdown deadline exceeded", { label });
						return;
					}
					const deferred = Promise.withResolvers<boolean>();
					const timer = setTimeout(() => deferred.resolve(false), remaining);
					void work.then(
						() => deferred.resolve(true),
						async (error: unknown) => {
							await logger.error("RPC shutdown failed", {
								errorType: error instanceof Error ? error.name : typeof error,
								label,
							});
							deferred.resolve(true);
						}
					);
					const completed = await deferred.promise;
					clearTimeout(timer);
					if (!completed) {
						void logger.warn("RPC shutdown deadline exceeded", { label });
					}
				};
				const activeHost = state.host;
				const hostShutdown = Promise.resolve().then(async () => {
					await activeHost?.shutdown();
				});
				await settle(hostShutdown, "host");
				state.host = undefined;
				for (const unsubscribe of unsubscribers.splice(0)) {
					unsubscribe();
				}
				const assemblyShutdown = Promise.resolve().then(async () => {
					await state.assembly?.shutdown();
				});
				await settle(assemblyShutdown, "capability");
				state.lifecycle = "closed";
				signal?.removeEventListener("abort", onAbort);
			})();
			return cleanupPromise;
		};
	})();

	const fatalShutdown = (error: unknown): Promise<void> => {
		if (fatalPromise !== undefined) {
			return fatalPromise;
		}
		fatal = true;
		inputAbortController.abort();
		let code = "internal_error";
		if (error instanceof RpcOutputOverflowError) {
			code = "output_overflow";
		} else if (error instanceof RpcApplicationError) {
			code = error.code;
		}
		const diagnosticWrite = logger.error("RPC fatal error", {
			code,
			errorType: error instanceof Error ? error.name : typeof error,
		});
		writeStderrDiagnostic(
			`RPC fatal error: ${error instanceof Error ? error.message : String(error)}`
		);
		const fatalFrame = {
			jsonrpc: JSON_RPC_VERSION,
			method: "server/fatal",
			params: {
				sequence: ++notificationSequence,
				error: { code },
			},
		};
		const notification = output.enqueue(fatalFrame).catch(() => undefined);
		fatalPromise = Promise.all([cleanup(), notification, diagnosticWrite]).then(
			() => undefined
		);
		return fatalPromise;
	};

	stopOutputError = stdout.onError?.((error: unknown) => {
		output.fail(error);
		void fatalShutdown(error);
	});
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted === true) {
		onAbort();
	}

	const emit = (method: string, params: unknown): void => {
		const frame: Record<string, unknown> = {
			jsonrpc: JSON_RPC_VERSION,
			method,
			params: { sequence: ++notificationSequence, ...(asRecord(params) ?? {}) },
		};
		const coalescable = method === "session/stateChanged";
		if (handlingRequest) {
			if (deferredOverflow) {
				return;
			}
			const bytes = Buffer.byteLength(`${JSON.stringify(frame)}\n`, "utf8");
			const tail = deferred.at(-1);
			if (coalescable && tail?.coalescable === true) {
				if (
					output.bufferedBytes + deferredBytes - tail.bytes + bytes >
					MAX_OUTPUT_BYTES
				) {
					deferredOverflow = true;
					return;
				}
				deferredBytes += bytes - tail.bytes;
				tail.bytes = bytes;
				tail.value = frame;
				return;
			}
			if (output.bufferedBytes + deferredBytes + bytes > MAX_OUTPUT_BYTES) {
				deferredOverflow = true;
				return;
			}
			deferred.push({ bytes, coalescable, value: frame });
			deferredBytes += bytes;
			return;
		}
		void output
			.enqueue(frame, { coalescable })
			.catch((error: unknown) => fatalShutdown(error));
	};
	const resetDeferred = (): void => {
		deferred.length = 0;
		deferredHead = 0;
		deferredBytes = 0;
		deferredOverflow = false;
	};
	const flushDeferred = async (): Promise<boolean> => {
		const alreadyOverflowed = deferredOverflow;
		while (deferredHead < deferred.length) {
			const notification = deferred[deferredHead];
			deferred[deferredHead] = undefined;
			deferredHead += 1;
			if (notification === undefined) {
				continue;
			}
			deferredBytes -= notification.bytes;
			await output.enqueue(notification.value, {
				coalescable: notification.coalescable,
			});
		}
		handlingRequest = false;
		const overflowed = alreadyOverflowed || deferredOverflow;
		resetDeferred();
		return overflowed;
	};

	const currentState = (): Record<string, unknown> => {
		if (state.host === undefined || state.boundSessionId === undefined) {
			throw appError("session_not_bound", "No Session Host is bound.");
		}
		const snapshot: SessionSnapshot = state.host.getSnapshot();
		const executions = snapshot.executions.map(projectExecution);
		const primary = [...snapshot.executions]
			.reverse()
			.find((execution) => execution.parent === undefined);
		const pendingApprovals = snapshot.approvals.filter(
			(approval) => approval.decision === undefined
		);
		const pendingApprovalIds = new Set(
			pendingApprovals.map((approval) => approval.id)
		);
		retireSettledApprovalWireIds(pendingApprovalIds);
		const approvals = pendingApprovals.map((approval) =>
			projectApproval(approval, wireApprovalId(approval))
		);
		const steering = snapshot.steeringMessages.map(projectSteering);
		const queue = snapshot.queuedSubmissions.map(projectQueued);
		const transcriptSignature =
			snapshot.transcriptRevision === undefined
				? JSON.stringify(snapshot.transcript.map(projectMessage))
				: String(snapshot.transcriptRevision);
		if (transcriptSignature !== lastTranscriptSignature) {
			transcriptRevision += 1;
			lastTranscriptSignature = transcriptSignature;
		}
		const projected: Record<string, unknown> = {
			activeCompaction: snapshot.isCompacting ? { active: true } : null,
			activeExecution: primary
				? (executions.find(
						(execution) => execution.turnId === primary.turnId
					) ?? null)
				: null,
			approvals,
			executions,
			sessionId: state.boundSessionId,
			selection: selectionFromHost(state.host),
			status: operationalStatus({
				approvals: approvals.length,
				compacting: snapshot.isCompacting,
				turnActive: snapshot.turnActive,
				waiting: steering.length > 0 || queue.length > 0,
			}),
			steering,
			transcript: {
				messageCount: snapshot.transcript.length,
				revision: transcriptRevision,
			},
			queue,
		};
		const signature = JSON.stringify(projected);
		if (signature !== lastStateSignature) {
			stateRevision += 1;
			lastStateSignature = signature;
			lastState = projected;
		}
		return { ...(lastState ?? projected), revision: stateRevision };
	};

	const notifyState = (): void => {
		if (state.host === undefined || state.boundSessionId === undefined) {
			return;
		}
		try {
			emit("session/stateChanged", { state: currentState() });
		} catch (error) {
			void fatalShutdown(error);
		}
	};

	const bind = (nextHost: SessionHost, sessionId: string): void => {
		if (state.signalRequested || state.lifecycle !== "initialized") {
			void nextHost.shutdown().catch(() => undefined);
			throw appError("server_closing", "The RPC server is closing.");
		}
		state.host = nextHost;
		state.boundSessionId = sessionId;
		state.lifecycle = "bound";
		lastStateSignature = "";
		lastTranscriptSignature = "";
		try {
			currentState();
		} catch (error) {
			void fatalShutdown(error);
		}
		unsubscribers.push(
			nextHost.onEvent((event) => {
				try {
					emit("session/event", {
						event: { kind: "agent-turn", event: projectAgentEvent(event) },
					});
				} catch (error) {
					void fatalShutdown(error);
				}
			}),
			nextHost.agentSession.onSubmissionEvent(
				(event: SessionSubmissionEvent) => {
					try {
						emit("session/event", {
							event: {
								kind: "submission",
								event: projectSubmissionEvent(event),
							},
						});
					} catch (error) {
						void fatalShutdown(error);
					}
				}
			),
			nextHost.onFatal((failureValue) => {
				void fatalShutdown(appError(failureValue.code, failureValue.code));
			}),
			nextHost.subscribe(notifyState)
		);
	};

	const requireInitialized = (): void => {
		if (state.lifecycle === "uninitialized") {
			throw appError(
				"not_initialized",
				"Initialize before using the Session API."
			);
		}
		if (state.lifecycle === "closing" || state.lifecycle === "closed") {
			throw appError("server_closing", "The RPC server is closing.");
		}
	};

	const requireBound = (): SessionHost => {
		requireInitialized();
		if (state.lifecycle !== "bound" || state.host === undefined) {
			throw appError(
				"session_not_bound",
				"Bind a Session before using this method."
			);
		}
		return state.host;
	};
	const { parseSelection, sendInput } = createSelectionHelpers({
		getAssembly: () => state.assembly,
		getRuntime,
	});
	const handleRequest = createRpcRequestHandler({
		autoApproval,
		bind,
		currentState,
		getRuntime,
		parseSelection,
		processId,
		providedComposer,
		requireBound,
		requireInitialized,
		resolveApprovalId: (wireApprovalId) =>
			approvalEngineIdsByWire.get(wireApprovalId),
		sendInput,
		state,
	});
	try {
		for await (const record of readJsonl(input, inputSignal)) {
			if (fatal) {
				break;
			}
			if (record.kind === "error") {
				if (record.fatal === true) {
					await fatalShutdown(new Error(record.message));
					break;
				}
				await output.enqueue(
					failure(null, RPC_ERROR_CODES.parseError, "Parse error")
				);
				continue;
			}
			const rawId = stringValue(asRecord(record.value)?.id);
			if (rawId !== undefined && seenRequestIds.has(rawId)) {
				await output.enqueue(
					failure(rawId, RPC_ERROR_CODES.invalidRequest, "Invalid Request", {
						code: "duplicate_request_id",
					})
				);
				continue;
			}
			if (rawId !== undefined) {
				seenRequestIds.add(rawId);
			}
			const parsed = parseRpcRequest(record.value);
			if (parsed.request === undefined) {
				await output.enqueue(
					failure(
						null,
						parsed.error?.code ?? RPC_ERROR_CODES.invalidRequest,
						"Invalid Request"
					)
				);
				continue;
			}
			const request = parsed.request;
			handlingRequest = true;
			resetDeferred();
			let response: RpcResponse;
			try {
				const requestResult = await Promise.race([
					handleRequest(request).then(
						(value) => ({ kind: "response" as const, value }),
						(error: unknown) => ({ kind: "error" as const, error })
					),
					abortRequested.promise.then(() => ({ kind: "aborted" as const })),
				]);
				if (requestResult.kind === "aborted") {
					handlingRequest = false;
					resetDeferred();
					await cleanup();
					break;
				}
				if (requestResult.kind === "error") {
					throw requestResult.error;
				}
				response = requestResult.value;
			} catch (error) {
				if (
					error instanceof RpcApplicationError &&
					error.code === "session_lease_lost"
				) {
					try {
						await flushDeferred();
					} catch {
						resetDeferred();
						handlingRequest = false;
					}
					await fatalShutdown(error);
					break;
				}
				if (error instanceof RpcApplicationError) {
					response = failure(
						request.id,
						APPLICATION_ERROR_CODE,
						error.message,
						{
							...(error.data ?? {}),
							code: error.code,
						}
					);
				} else if (error instanceof RpcProtocolError) {
					response = failure(request.id, error.code, error.message);
				} else {
					try {
						await flushDeferred();
					} catch {
						resetDeferred();
						handlingRequest = false;
					}
					await fatalShutdown(error);
					break;
				}
			}
			if (state.shutdownRequested) {
				await cleanup();
			}
			const responseBytes = Buffer.byteLength(
				`${JSON.stringify(response)}\n`,
				"utf8"
			);
			const responseWouldOverflow =
				output.bufferedBytes + deferredBytes + responseBytes > MAX_OUTPUT_BYTES;
			if (deferredOverflow || responseWouldOverflow) {
				if (
					deferredOverflow &&
					output.bufferedBytes + responseBytes <= MAX_OUTPUT_BYTES
				) {
					await output.enqueue(response);
				}
				try {
					await flushDeferred();
				} catch {
					resetDeferred();
				}
				handlingRequest = false;
				await fatalShutdown(new RpcOutputOverflowError());
				break;
			}
			await output.enqueue(response);
			const overflowedDuringFlush = await flushDeferred();
			handlingRequest = false;
			if (overflowedDuringFlush) {
				await fatalShutdown(new RpcOutputOverflowError());
				break;
			}
			if (state.shutdownRequested) {
				break;
			}
		}
	} catch (error) {
		if (state.signalRequested && !fatal) {
			await cleanup();
			detachOutputError();
			return requestedExitCode ?? 1;
		}
		await fatalShutdown(error);
		detachOutputError();
		return 1;
	}
	if (fatalPromise !== undefined) {
		await fatalPromise;
		detachOutputError();
		return 1;
	}
	await cleanup();
	try {
		await output.drain();
	} catch (error) {
		await fatalShutdown(error);
		return 1;
	} finally {
		detachOutputError();
	}
	return requestedExitCode ?? (fatal ? 1 : 0);
}

export type { OutputWriter, RpcRunnerOptions } from "./types";
