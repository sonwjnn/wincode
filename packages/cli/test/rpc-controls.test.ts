import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import type {
	SessionApprovalResult,
	SessionHost,
	SessionInterruptResult,
	SessionSendInput,
	SessionSubmissionAdmission,
} from "@wincode/tui/session-rpc";
import type { RpcRequest } from "../src/rpc/protocol";
import { createRpcRequestHandler } from "../src/rpc/request-handler";
import type {
	RpcSessionState,
	RuntimeModules,
	Selection,
} from "../src/rpc/types";

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
