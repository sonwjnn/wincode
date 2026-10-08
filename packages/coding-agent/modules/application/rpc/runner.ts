import { logger } from "@wincode/utils";
import { getCustomCommands } from "@/modules/commands/custom/loader";
import { resolveSubmissionPrompt } from "@/modules/commands/submission-resolution";
import { expandPastedText } from "@/modules/sessions/pasted-text";
import { discoverSkills } from "@/modules/skills";
import type { SessionId } from "@/shared/identifiers";
import { errorLogFields } from "@/shared/utils/error-log-fields";
import type {
	LiveSessionSnapshot,
	SessionHost,
	SessionSubmissionEvent,
} from "../../../modules/sessions/host/session-rpc";
import { type DeferredNotification, SerializedWriter } from "./output";
import {
	operationalStatus,
	projectAgentEvent,
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
	type RpcPreparedSubmission,
	RpcProtocolError,
	type RpcRunnerOptions,
	type RpcSessionState,
	type RpcSubmissionDraft,
	type RuntimeModules,
	SESSION_RPC_METHODS,
} from "./types";
import { appError, asRecord, stringValue } from "./validation";

export const reportDeferredFlushFailure = (
	error: unknown,
	loggedOutputFailure: Error | undefined,
	rpcMethod: string | undefined
): void => {
	if (loggedOutputFailure !== undefined && error === loggedOutputFailure) {
		return;
	}
	void logger.warn("RPC deferred output flush failed", {
		...errorLogFields(error),
		operation: "rpc.output",
		phase: "deferred-flush",
		...(rpcMethod === undefined ? {} : { rpcMethod }),
	});
};
const diagnosticRpcMethod = (method: string): string | undefined =>
	method === "initialize" ||
	method === "server/shutdown" ||
	SESSION_RPC_METHODS.has(method)
		? method
		: undefined;
const logRpcFatalDiagnostic = (
	error: unknown,
	code: string,
	rpcMethod: string | undefined
): Promise<void> => {
	const context = {
		...errorLogFields(error),
		rpcErrorCode: code,
		...(rpcMethod === undefined ? {} : { rpcMethod }),
	};
	if (error instanceof RpcOutputOverflowError) {
		return logger.warn("RPC output overflow; continuation refused", {
			...context,
			operation: "rpc.output",
			phase: "overflow",
		});
	}
	return logger.error("RPC fatal error", {
		...context,
		operation: "rpc",
		phase: "fatal",
	});
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This controller owns the JSONL lifecycle, output ordering, and teardown boundary.
export async function runRpc({
	configRuntime,
	disabledPluginIds,
	pluginPaths,
	pluginRuntime,
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
	const processId = crypto.randomUUID();
	const seenRequestIds = new Set<string>();
	const deferred: Array<DeferredNotification | undefined> = [];
	let deferredHead = 0;
	let deferredBytes = 0;
	let deferredOverflow = false;
	const unsubscribers: Array<() => void> = [];
	const boundUnsubscribers: Array<() => void> = [];
	let runtime: RuntimeModules | undefined;
	const state: RpcSessionState = {
		lifecycle: "uninitialized",
		shutdownRequested: false,
		signalRequested: false,
	};
	let handlingRequest = false;
	let activeRpcMethod: string | undefined;
	let requestedExitCode: number | undefined;
	const abortRequested = Promise.withResolvers<void>();
	let fatal = false;
	let loggedOutputFailure: Error | undefined;
	let fatalPromise: Promise<void> | undefined;
	let notificationSequence = 0;
	let stateRevision = 0;
	let transcriptRevision = 0;
	let lastStateSignature = "";
	let lastTranscriptSignature = "";
	let lastState: Record<string, unknown> | undefined;
	const getRuntime = async (): Promise<RuntimeModules> => {
		if (runtime === undefined) {
			runtime = await loadRuntime({
				configRuntime,
				disabledPluginIds,
				pluginPaths,
				pluginRuntime,
			});
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
					const fields = {
						operation: "rpc.shutdown",
						phase: label,
						label,
						...(activeRpcMethod === undefined
							? {}
							: { rpcMethod: activeRpcMethod }),
					};
					const remaining = Math.max(0, deadline - Date.now());
					if (remaining === 0) {
						void logger.warn("RPC shutdown deadline exceeded", fields);
						return;
					}
					const deferred = Promise.withResolvers<boolean>();
					const timer = setTimeout(() => deferred.resolve(false), remaining);
					void work.then(
						() => deferred.resolve(true),
						async (error: unknown) => {
							await logger.error("RPC shutdown failed", {
								...errorLogFields(error),
								...fields,
							});
							deferred.resolve(true);
						}
					);
					const completed = await deferred.promise;
					clearTimeout(timer);
					if (!completed) {
						void logger.warn("RPC shutdown deadline exceeded", fields);
					}
				};
				const assemblyShutdown = Promise.resolve().then(async () => {
					await state.assembly?.shutdown();
				});
				await settle(assemblyShutdown, "capability");
				state.host = undefined;
				state.boundSessionId = undefined;
				for (const unsubscribe of boundUnsubscribers.splice(0)) {
					unsubscribe();
				}
				for (const unsubscribe of unsubscribers.splice(0)) {
					unsubscribe();
				}
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
		const outputFailure =
			error instanceof Error && error === output.failureError
				? error
				: undefined;
		if (outputFailure !== undefined) {
			loggedOutputFailure = outputFailure;
		}
		const diagnosticWrite = logRpcFatalDiagnostic(error, code, activeRpcMethod);
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
		const normalizedError =
			error instanceof Error ? error : new Error(String(error));
		const fatalOwner = !fatal;
		output.fail(normalizedError);
		if (fatalOwner) {
			void fatalShutdown(normalizedError);
		}
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
		const snapshot: LiveSessionSnapshot = state.host.getSnapshot();
		const executions = snapshot.executions.map(projectExecution);
		const primary = snapshot.executions.at(-1);
		const steering = snapshot.steeringMessages.map(projectSteering);
		const pendingSteering = snapshot.steeringMessages.length > 0;
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
			executions,
			sessionId: state.boundSessionId,
			selection: selectionFromHost(state.host),
			status: operationalStatus({
				compacting: snapshot.isCompacting,
				turnActive: snapshot.turnActive,
				waiting: pendingSteering || queue.length > 0,
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

	const releaseSessionView = (sessionId: SessionId): void => {
		const manager = state.assembly?.capabilities.getSessionHostManager();
		if (manager !== undefined) {
			void manager.releaseView(sessionId).catch((error: unknown) => {
				void logger.warn("RPC Session view release failed", {
					...errorLogFields(error),
					sessionId,
				});
			});
		}
	};
	const unbind = (): void => {
		const previousSessionId = state.boundSessionId;
		for (const unsubscribe of boundUnsubscribers.splice(0)) {
			unsubscribe();
		}
		state.host = undefined;
		state.boundSessionId = undefined;
		if (state.lifecycle === "bound") {
			state.lifecycle = "initialized";
		}
		if (previousSessionId !== undefined) {
			releaseSessionView(previousSessionId);
		}
	};
	const bind = (nextHost: SessionHost, sessionId: SessionId): void => {
		const previousSessionId = state.boundSessionId;
		if (
			state.signalRequested ||
			(state.lifecycle !== "initialized" && state.lifecycle !== "bound")
		) {
			releaseSessionView(sessionId);
			throw appError("server_closing", "The RPC server is closing.");
		}
		for (const unsubscribe of boundUnsubscribers.splice(0)) {
			unsubscribe();
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
		boundUnsubscribers.push(
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
			nextHost.subscribe(notifyState)
		);
		if (previousSessionId !== undefined) {
			releaseSessionView(previousSessionId);
		}
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
	const prepareSubmission = async (
		draft: RpcSubmissionDraft
	): Promise<RpcPreparedSubmission> => {
		const activeAssembly = state.assembly;
		if (activeAssembly === undefined) {
			throw appError("not_initialized", "Initialize before submitting.");
		}
		const config = activeAssembly.capabilities.getConfig();
		const text = expandPastedText(
			draft.composition.text,
			draft.composition.pastedText ?? []
		).trim();
		const prepared = await resolveSubmissionPrompt({
			intents: draft.intent === undefined ? [] : [draft.intent],
			text,
			discoverSkills: () => discoverSkills(config),
			discoverCustomCommands: () => getCustomCommands(config),
		});
		if (prepared.kind === "rejected") {
			throw appError("submission_rejected", prepared.reason);
		}
		return {
			composition: draft.composition,
			files: draft.files,
			userText: prepared.text,
			...(prepared.skill === undefined ? {} : { skill: prepared.skill }),
		};
	};
	const handleRequest = createRpcRequestHandler({
		bind,
		unbind,
		currentState,
		getRuntime,
		parseSelection,
		processId,
		providedComposer,
		requireBound,
		requireInitialized,
		prepareSubmission,
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
			activeRpcMethod = diagnosticRpcMethod(request.method);
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
					activeRpcMethod = undefined;
					resetDeferred();
					await cleanup();
					break;
				}
				if (requestResult.kind === "error") {
					throw requestResult.error;
				}
				response = requestResult.value;
			} catch (error) {
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
					} catch (flushError) {
						reportDeferredFlushFailure(
							flushError,
							loggedOutputFailure,
							activeRpcMethod
						);
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
				} catch (flushError) {
					reportDeferredFlushFailure(
						flushError,
						loggedOutputFailure,
						activeRpcMethod
					);
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
			activeRpcMethod = undefined;
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
