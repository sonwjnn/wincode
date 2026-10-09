import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import {
	RPC_ERROR_CODES,
	type RpcRequest,
} from "../modules/application/rpc/protocol";
import { createRpcRequestHandler } from "../modules/application/rpc/request-handler";
import type {
	RpcAssembly,
	RpcSessionState,
	RpcSubmissionDraft,
	RuntimeModules,
	Selection,
} from "../modules/application/rpc/types";
import { readSubmission } from "../modules/application/rpc/validation";
import type {
	SessionSteeringMessage,
	SessionSubmissionEvent,
} from "../modules/sessions/agent-session/types";
import type {
	AttachmentReference,
	AttachmentReferenceResolver,
} from "../modules/sessions/attachment-reference";
import type {
	SessionHost,
	SessionId,
	SessionInterruptResult,
	SessionMessage,
	SessionSendInput,
	SessionSteeringAdmission,
	SessionStore,
	SessionSubmissionAdmission,
} from "../modules/sessions/host/session-rpc";
import type { SessionHostManager } from "../modules/sessions/host/types";
import type { SessionSendOutcome } from "../modules/sessions/submission-types";

const model = fromPartial<Selection["model"]>({
	modelId: "gpt-5.6-luna",
	providerId: "openai",
});

const request = (
	id: string,
	method: string,
	params: Record<string, unknown>
): RpcRequest => ({ id, jsonrpc: "2.0", method, params }) as RpcRequest;

const createHandler = ({
	admission = fromPartial<SessionSubmissionAdmission>({
		disposition: "started",
		messageId: "message-1",
		rejected: false,
		submissionId: "submission-1",
	}),
	steeringAdmission = {
		kind: "steered",
		messageId: "steered-message-1",
		submissionId: "steered-submission-1",
		turnId: "turn-1",
	} as unknown as SessionSteeringAdmission,
	interruptResult = fromPartial<SessionInterruptResult>({
		kind: "none",
		recalled: [],
	}),
	selected = true,
	active = false,
	retryableSubmission,
	attachmentStore,
	send,
}: Readonly<{
	admission?: SessionSubmissionAdmission;
	interruptResult?: SessionInterruptResult;
	selected?: boolean;
	active?: boolean;
	steeringAdmission?: SessionSteeringAdmission;
	retryableSubmission?: SessionSteeringMessage;
	attachmentStore?: NonNullable<SessionStore["attachmentStore"]>;
	send?: (
		input: SessionSendInput,
		emit: (event: SessionSubmissionEvent) => void
	) => Promise<SessionSendOutcome>;
}> = {}): {
	handler: (requestValue: RpcRequest) => Promise<unknown>;
	drafts: RpcSubmissionDraft[];
	inputs: SessionSendInput[];
	recalledIds: Array<readonly string[] | undefined>;
	steerCalls: number;
} => {
	const inputs: SessionSendInput[] = [];
	const recalledIds: Array<readonly string[] | undefined> = [];
	const drafts: RpcSubmissionDraft[] = [];
	const submissionEventListeners = new Set<
		(event: SessionSubmissionEvent) => void
	>();
	let steerCalls = 0;
	const emitSubmissionEvent = (event: SessionSubmissionEvent): void => {
		for (const listener of submissionEventListeners) {
			listener(event);
		}
	};
	const engine = {
		prompt: async (
			input: SessionSendInput
		): Promise<SessionSubmissionAdmission> => {
			inputs.push(input);
			return admission;
		},
		send: (input: SessionSendInput): Promise<SessionSendOutcome> =>
			send === undefined
				? Promise.resolve({
						rejected: true,
						reason: "No retry behavior is configured.",
					})
				: send(input, emitSubmissionEvent),
		onSubmissionEvent: (
			listener: (event: SessionSubmissionEvent) => void
		): (() => void) => {
			submissionEventListeners.add(listener);
			return () => submissionEventListeners.delete(listener);
		},
		steer: async (): Promise<SessionSteeringAdmission> => {
			steerCalls += 1;
			return steeringAdmission;
		},
		interruptAll: () => interruptResult,
		recallWaitingMessages: (ids: readonly string[] | undefined) => {
			recalledIds.push(ids);
			return [];
		},
	};
	const host = {
		agentSession: engine,
		getSelection: () =>
			selected
				? {
						agent: "build",
						model,
						persistedAgent: "build",
						thinkingLevel: undefined,
					}
				: null,
		getSnapshot: () =>
			fromPartial({
				isCompacting: false,
				steeringMessages:
					retryableSubmission === undefined ? [] : [retryableSubmission],
				turnActive: active,
			}),
	} as unknown as SessionHost;
	const state: RpcSessionState = {
		...(attachmentStore === undefined
			? {}
			: {
					assembly: fromPartial<RpcAssembly>({
						store: fromPartial<SessionStore>({ attachmentStore }),
					}),
				}),
		boundSessionId: "session-1" as SessionId,
		lifecycle: "bound",
		shutdownRequested: false,
		signalRequested: false,
	};
	const handler = createRpcRequestHandler({
		bind: () => undefined,
		unbind: () => undefined,
		currentState: () => ({}),
		getRuntime: async () => undefined as unknown as RuntimeModules,
		parseSelection: async (value): Promise<Selection> => value as Selection,
		prepareSubmission: async (draft) => {
			drafts.push(draft);
			return {
				composition: draft.composition,
				files: draft.files,
				userText: draft.composition.text,
			};
		},
		processId: "process-1",
		requireBound: () => host,
		requireInitialized: () => undefined,
		sendInput: (selection, submission, ids): SessionSendInput => {
			const input = {
				agent: selection.agentId,
				composition: submission.composition,
				files: submission.files,
				model: selection.model,
				sessionModel: selection.model,
				userText: submission.userText,
				...(submission.skill === undefined ? {} : { skill: submission.skill }),
				...ids,
			} as SessionSendInput;
			return input;
		},
		state,
	});
	return {
		handler,
		get steerCalls() {
			return steerCalls;
		},
		drafts,
		inputs,
		recalledIds,
	};
};

test("session submit uses fallback selection and honors a complete override", async () => {
	const admission = fromPartial<SessionSubmissionAdmission>({
		disposition: "started",
		messageId: "message-1",
		rejected: false,
		submissionId: "submission-1",
	});
	const controls = createHandler({ admission });
	const fallback = await controls.handler(
		request("submit-fallback", "session/submit", {
			submission: { text: "fallback text" },
		})
	);

	expect(fallback).toMatchObject({
		id: "submit-fallback",
		result: admission,
	});
	expect(controls.inputs.at(-1)).toMatchObject({
		userText: "fallback text",
	});

	const override = {
		agentId: "review",
		model,
	};
	const overridden = await controls.handler(
		request("submit-override", "session/submit", {
			selection: override,
			submission: { text: "override text" },
		})
	);

	expect(overridden).toMatchObject({
		id: "submit-override",
		result: admission,
	});
	expect(controls.inputs.at(-1)).toMatchObject({
		agent: "review",
		userText: "override text",
	});
});

test("session submit always prompts while active; explicit steer owns queue promotion", async () => {
	const queuedAdmission = fromPartial<SessionSubmissionAdmission>({
		disposition: "queued",
		messageId: "queued-message-1",
		rejected: false,
		submissionId: "queued-submission-1",
	});
	const steeringAdmission = {
		kind: "steered",
		messageId: "steered-message-1",
		submissionId: "steered-submission-1",
		turnId: "turn-1",
	} as unknown as SessionSteeringAdmission;
	const controls = createHandler({
		active: true,
		admission: queuedAdmission,
		steeringAdmission,
	});

	await expect(
		controls.handler(
			request("submit-busy", "session/submit", {
				submission: { text: "correction" },
			})
		)
	).resolves.toMatchObject({ result: queuedAdmission });
	expect(controls.inputs).toHaveLength(1);
	expect(controls.inputs[0]).toMatchObject({ userText: "correction" });
	expect(controls.steerCalls).toBe(0);

	await expect(
		controls.handler(request("steer-head", "session/steer", {}))
	).resolves.toMatchObject({ result: steeringAdmission });
	expect(controls.steerCalls).toBe(1);
});

test("empty session steer explicitly reports that no message was accepted", async () => {
	const emptyOutcome = { kind: "empty" } as unknown as SessionSteeringAdmission;
	const controls = createHandler({ steeringAdmission: emptyOutcome });

	await expect(
		controls.handler(request("steer-empty", "session/steer", {}))
	).resolves.toEqual({
		id: "steer-empty",
		jsonrpc: "2.0",
		result: { kind: "empty" },
	});
	expect(controls.inputs).toHaveLength(0);
	expect(controls.steerCalls).toBe(1);
});

test("session steer rejects caller-supplied content", async () => {
	const controls = createHandler();

	await expect(
		controls.handler(
			request("steer-with-text", "session/steer", {
				text: "Do not steer this text",
			})
		)
	).rejects.toMatchObject({ code: RPC_ERROR_CODES.invalidParams });
	expect(controls.steerCalls).toBe(0);
});

test("session submit accepts structured bounded files and explicit Skill intent", async () => {
	const controls = createHandler();
	await controls.handler(
		request("submit-structured", "session/submit", {
			submission: {
				composition: {
					fileTokens: [{ start: 6, token: "[Image 1]" }],
					files: [
						{
							content: { data: "AQID", encoding: "base64" },
							filename: "diagram.png",
							mediaType: "image/png",
						},
					],
					text: "Check [Image 1]",
				},
				intent: { kind: "skill", name: "review" },
			},
		})
	);

	expect(controls.drafts[0]).toMatchObject({
		composition: {
			fileTokens: [{ start: 6, token: "[Image 1]" }],
			text: "Check [Image 1]",
		},
		files: [
			{
				filename: "diagram.png",
				mediaType: "image/png",
				url: "data:image/png;base64,AQID",
			},
		],
		intent: { kind: "skill", name: "review" },
	});
	expect(controls.inputs[0]).toMatchObject({
		composition: { text: "Check [Image 1]" },
		files: [{ filename: "diagram.png" }],
	});
});

test("session submit uses verified attachment dimensions instead of client metadata", async () => {
	const attachmentId = `v1-${"a".repeat(64)}`;
	const reference = {
		attachmentId,
		available: true,
		byteLength: 3,
		filename: "diagram.png",
		height: 1,
		mediaType: "image/png",
		width: 1,
	};
	const submission = await readSubmission(
		{
			submission: {
				files: [{ ...reference, type: "file" }],
				text: "Review the diagram",
			},
		},
		"submission",
		{
			resolve: async (value: AttachmentReference) => ({
				availability: "available",
				reference: { ...value, height: 1024, width: 1024 },
			}),
		} satisfies AttachmentReferenceResolver
	);

	expect(submission.files[0]).toMatchObject({
		attachmentId,
		height: 1024,
		type: "file",
		url: `attachment://${attachmentId}`,
		width: 1024,
	});
});

test("session submit rejects missing or corrupt stored attachments before admission", async () => {
	const attachmentId = `v1-${"a".repeat(64)}`;
	for (const availability of ["missing", "corrupt"] as const) {
		const controls = createHandler({
			attachmentStore: fromPartial<
				NonNullable<SessionStore["attachmentStore"]>
			>({
				resolve: async (reference: AttachmentReference) => ({
					availability,
					reference,
				}),
			}),
		});

		await expect(
			controls.handler(
				request("submit-reference", "session/submit", {
					submission: {
						files: [
							{
								attachmentId,
								byteLength: 3,
								filename: "diagram.png",
								mediaType: "image/png",
								type: "file",
							},
						],
						text: "Review the diagram",
					},
				})
			)
		).rejects.toMatchObject({ code: "submission_rejected" });
		expect(controls.inputs).toHaveLength(0);
	}
});

test("session submit rejects arbitrary attachment paths before admission", async () => {
	const controls = createHandler();

	await expect(
		controls.handler(
			request("submit-path", "session/submit", {
				submission: {
					files: [{ filename: "secret.txt", path: "/etc/passwd" }],
					text: "Read this file",
				},
			})
		)
	).rejects.toMatchObject({ code: "submission_rejected" });
	expect(controls.inputs).toHaveLength(0);
});

test("session retry responds at the durable start event before the turn settles", async () => {
	const messageId = "steered-message-1";
	const submissionId = "steered-submission-1";
	const retryableSubmission = fromPartial<SessionSteeringMessage>({
		input: fromPartial<SessionSendInput>({ messageId, submissionId }),
		message: fromPartial<SessionMessage>({ id: messageId }),
		status: "failed",
	});
	const sendCompletion = Promise.withResolvers<SessionSendOutcome>();
	const sendFinished = Promise.withResolvers<void>();
	let sendSettled = false;
	const controls = createHandler({
		retryableSubmission,
		send: (_input, emit) => {
			emit(
				fromPartial<SessionSubmissionEvent>({
					kind: "started",
					messageId,
					submissionId,
				})
			);
			return sendCompletion.promise.then((outcome) => {
				sendSettled = true;
				sendFinished.resolve();
				return outcome;
			});
		},
	});
	const response = await controls.handler(
		request("retry", "session/retry", { submissionId })
	);

	expect(sendSettled).toBe(false);
	sendCompletion.resolve({ rejected: false });
	await sendFinished.promise;
	expect(response).toMatchObject({
		result: {
			kind: "retrying",
			messageId,
			submissionId,
		},
	});
});

test("interrupt and recall return Engine control outcomes", async () => {
	const controls = createHandler({
		interruptResult: {
			kind: "turn",
			recalled: [],
		},
	});

	await expect(
		controls.handler(request("interrupt", "session/interrupt", {}))
	).resolves.toMatchObject({
		result: {
			recalled: [],
			stopped: "turn",
		},
	});
	await expect(
		controls.handler(
			request("recall", "session/recall", {
				submissionIds: ["submission-1"],
			})
		)
	).resolves.toMatchObject({ result: { recalled: [] } });
	expect(controls.recalledIds).toEqual([["submission-1"]]);
});

test("submit refuses when fallback selection is unavailable before admission", async () => {
	const controls = createHandler({ selected: false });
	await expect(
		controls.handler(
			request("submit", "session/submit", {
				submission: { text: "cannot run" },
			})
		)
	).rejects.toMatchObject({ code: "selection_required" });
	expect(controls.inputs).toHaveLength(0);
});

test("failed Session creation stays durable and can be reopened", async () => {
	const selection: Selection = { agentId: "build", model };
	const store = fromPartial<SessionStore>({
		createSession: async () => ({ id: "session-1" }),
		externalizeAttachments: async (messages: readonly SessionMessage[]) => [
			...messages,
		],
		getSession: async () => fromPartial({ id: "session-1" }),
	});
	const state: RpcSessionState = {
		lifecycle: "uninitialized",
		shutdownRequested: false,
		signalRequested: false,
	};
	const host = fromPartial<SessionHost>({
		agentSession: {
			prompt: async () =>
				fromPartial<SessionSubmissionAdmission>({
					disposition: "started",
					messageId: "message-1",
					rejected: false,
					submissionId: "submission-1",
				}),
		},
		shutdown: async () => undefined,
	});
	let hostAttempts = 0;
	const runtime = fromPartial<RuntimeModules>({
		createAgentTurnId: () => "turn-1",
		createSessionCapabilities: async () =>
			fromPartial({
				capabilities: {
					getSessionHostManager: () =>
						fromPartial<SessionHostManager>({
							releaseView: async () => undefined,
						}),
				},
				shutdown: async () => undefined,
				store,
				workspace: process.cwd(),
				workspaceId: "workspace-1",
			}),
		createSessionHost: async () => {
			hostAttempts += 1;
			if (hostAttempts === 1) {
				throw new Error("host unavailable");
			}
			return host;
		},
		createSessionUserMessage: () =>
			({
				id: "message-1",
				parts: [],
				role: "user",
			}) as unknown as SessionMessage,
		resolveWorkspaceRoot: (start: string): string => start,
		toSessionId: (value: string): SessionId => value as SessionId,
	});
	const bind = (nextHost: SessionHost, sessionId: SessionId): void => {
		state.host = nextHost;
		state.boundSessionId = sessionId;
		state.lifecycle = "bound";
	};
	const handler = createRpcRequestHandler({
		bind,
		unbind: () => {
			state.host = undefined;
			state.boundSessionId = undefined;
			state.lifecycle = "initialized";
		},
		currentState: () => ({}),
		getRuntime: async () => runtime,
		parseSelection: async () => selection,
		prepareSubmission: async (draft) => ({
			composition: draft.composition,
			files: draft.files,
			userText: draft.composition.text,
		}),
		processId: "process-1",
		requireBound: () => {
			if (state.host === undefined) {
				throw new Error("not bound");
			}
			return state.host;
		},
		requireInitialized: () => undefined,
		sendInput: (_selected, submission, ids) =>
			fromPartial({
				composition: submission.composition,
				files: submission.files,
				model,
				sessionModel: model,
				userText: submission.userText,
				...ids,
			}),
		state,
	});

	await handler(
		request("initialize", "initialize", {
			capabilities: {},
			clientInfo: { name: "test-client" },
			cwd: process.cwd(),
			protocolVersion: 4,
		})
	);
	await expect(
		handler(
			request("create", "session/create", {
				initialSubmission: { text: "start" },
				selection,
			})
		)
	).rejects.toMatchObject({
		code: "session_created_but_unbound",
		data: { sessionId: "session-1", stage: "host" },
	});
	expect(state.host).toBeUndefined();
	expect(state.boundSessionId).toBeUndefined();
	expect(state.lifecycle).toBe("initialized");

	await expect(
		handler(request("open", "session/open", { sessionId: "session-1" }))
	).resolves.toMatchObject({ result: { sessionId: "session-1" } });
	expect(hostAttempts).toBe(2);
});
