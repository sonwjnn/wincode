import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import type { RpcRequest } from "../modules/application/rpc/protocol";
import { createRpcRequestHandler } from "../modules/application/rpc/request-handler";
import type {
	RpcSessionState,
	RuntimeModules,
	Selection,
} from "../modules/application/rpc/types";
import type {
	SessionApprovalResult,
	SessionHost,
	SessionId,
	SessionInterruptResult,
	SessionSendInput,
	SessionStore,
	SessionSubmissionAdmission,
} from "../modules/sessions/host/session-rpc";

type CapturedApproval = Readonly<{
	id: string;
	outcome: unknown;
}>;

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
	approvalResult = { applied: true } as SessionApprovalResult,
	interruptResult = fromPartial<SessionInterruptResult>({
		approvalsSettled: 0,
		kind: "none",
		recalled: [],
	}),
	selected = true,
}: Readonly<{
	admission?: SessionSubmissionAdmission;
	approvalResult?: SessionApprovalResult;
	interruptResult?: SessionInterruptResult;
	selected?: boolean;
}> = {}): {
	handler: (requestValue: RpcRequest) => Promise<unknown>;
	approvals: CapturedApproval[];
	inputs: SessionSendInput[];
	recalledIds: Array<readonly string[] | undefined>;
	setApprovalResult: (result: SessionApprovalResult) => void;
} => {
	const approvals: CapturedApproval[] = [];
	const inputs: SessionSendInput[] = [];
	const recalledIds: Array<readonly string[] | undefined> = [];
	let currentApprovalResult = approvalResult;
	const engine = {
		admit: (input: SessionSendInput): SessionSubmissionAdmission => {
			inputs.push(input);
			return admission;
		},
		interruptAll: () => interruptResult,
		recallWaitingMessages: (ids: readonly string[] | undefined) => {
			recalledIds.push(ids);
			return [];
		},
		respondToApproval: (
			id: string,
			outcome: unknown
		): SessionApprovalResult => {
			approvals.push({ id, outcome });
			return currentApprovalResult;
		},
	};
	const host = {
		engine,
		getSelection: () =>
			selected
				? {
						agent: "build",
						model,
						persistedAgent: "build",
						variant: undefined,
					}
				: null,
		getSnapshot: () => {
			throw new Error("The RPC adapter must not read a snapshot.");
		},
	} as unknown as SessionHost;
	const state: RpcSessionState = {
		boundSessionId: "session-1",
		lifecycle: "bound",
		shutdownRequested: false,
		signalRequested: false,
	};
	const handler = createRpcRequestHandler({
		bind: () => undefined,
		currentState: () => ({}),
		getRuntime: async () => undefined as unknown as RuntimeModules,
		parseSelection: async (value): Promise<Selection> => value as Selection,
		processId: "process-1",
		requireBound: () => host,
		requireInitialized: () => undefined,
		resolveApprovalId: (wireId) =>
			wireId === "wire-approval-1" ? "engine-approval-1" : undefined,
		sendInput: (selection, text): SessionSendInput => {
			const input = {
				agent: selection.agentId,
				model: selection.model,
				sessionModel: selection.model,
				userText: text,
			} as SessionSendInput;
			inputs.push(input);
			return input;
		},
		state,
	});
	return {
		handler,
		approvals,
		inputs,
		recalledIds,
		setApprovalResult: (result) => {
			currentApprovalResult = result;
		},
	};
};

test("session submit uses fallback selection and honors a complete override", async () => {
	const admission = fromPartial<SessionSubmissionAdmission>({
		disposition: "steering",
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

test("approval responses use wire identities and Engine authority", async () => {
	const controls = createHandler();

	expect(
		await controls.handler(
			request("unknown", "session/respondToApproval", {
				approvalId: "unknown",
				decision: "allowOnce",
			})
		)
	).toMatchObject({ result: { applied: false } });
	expect(controls.approvals).toHaveLength(0);

	controls.setApprovalResult({
		applied: false,
		reason: "persistence-forbidden",
	});
	await expect(
		controls.handler(
			request("safety", "session/respondToApproval", {
				approvalId: "wire-approval-1",
				decision: "alwaysAllow",
			})
		)
	).rejects.toMatchObject({ code: "approval_persistence_forbidden" });

	controls.setApprovalResult({ applied: true });
	const allowed = await controls.handler(
		request("allow", "session/respondToApproval", {
			approvalId: "wire-approval-1",
			decision: "allowOnce",
		})
	);
	const rejected = await controls.handler(
		request("reject", "session/respondToApproval", {
			approvalId: "wire-approval-1",
			decision: "reject",
			feedback: "not now",
		})
	);
	const aborted = await controls.handler(
		request("abort", "session/respondToApproval", {
			approvalId: "wire-approval-1",
			decision: "abort",
		})
	);

	expect(allowed).toMatchObject({ result: { applied: true } });
	expect(rejected).toMatchObject({ result: { applied: true } });
	expect(aborted).toMatchObject({ result: { applied: true } });
	expect(controls.approvals).toEqual([
		{
			id: "engine-approval-1",
			outcome: { decision: "allow", remember: true },
		},
		{
			id: "engine-approval-1",
			outcome: { decision: "allow", remember: false },
		},
		{
			id: "engine-approval-1",
			outcome: { decision: "reject", feedback: "not now" },
		},
		{
			id: "engine-approval-1",
			outcome: { decision: "abort" },
		},
	]);
});

test("interrupt and recall return Engine control outcomes", async () => {
	const controls = createHandler({
		interruptResult: {
			approvalsSettled: 2,
			kind: "turn",
			recalled: [],
		},
	});

	await expect(
		controls.handler(request("interrupt", "session/interrupt", {}))
	).resolves.toMatchObject({
		result: {
			recalled: [],
			settledApprovals: 2,
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
		getSession: async () => fromPartial({ id: "session-1" }),
	});
	const state: RpcSessionState = {
		lifecycle: "uninitialized",
		shutdownRequested: false,
		signalRequested: false,
	};
	const host = fromPartial<SessionHost>({
		engine: {
			admit: () =>
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
				capabilities: {},
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
		createSessionUserMessage: () => fromPartial({ id: "message-1" }),
		resolveWorkspaceRoot: (start: string): string => start,
		toSessionId: (value: string): SessionId => value as SessionId,
	});
	const bind = (nextHost: SessionHost, sessionId: string): void => {
		state.host = nextHost;
		state.boundSessionId = sessionId;
		state.lifecycle = "bound";
	};
	const handler = createRpcRequestHandler({
		bind,
		currentState: () => ({}),
		getRuntime: async () => runtime,
		parseSelection: async () => selection,
		processId: "process-1",
		requireBound: () => {
			if (state.host === undefined) {
				throw new Error("not bound");
			}
			return state.host;
		},
		requireInitialized: () => undefined,
		resolveApprovalId: () => undefined,
		sendInput: (_selected, text) =>
			fromPartial({ model, sessionModel: model, userText: text }),
		state,
	});

	await handler(
		request("initialize", "initialize", {
			capabilities: {},
			clientInfo: { name: "test-client" },
			cwd: process.cwd(),
			protocolVersion: 1,
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
