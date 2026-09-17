import { expect, mock, test } from "bun:test";
import { isUndefined } from "@wincode/runtime-utils";
import { projectSessionApprovals } from "@/modules/sessions/approval-projection";
import type {
	SessionApproval,
	SessionApprovalOutcome,
} from "@/modules/sessions/engine/types";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import { toolCallId } from "../support/identifiers";

const request = (callId?: string): ToolApprovalRequest => ({
	description: "Read a UTF-8 text file inside the workspace.",
	identity: [{ label: "tool", value: "read" }],
	input: { path: ".env" },
	...(isUndefined(callId) ? {} : { toolCallId: toolCallId(callId) }),
});

const approval = (
	id: string,
	decision?: SessionApprovalOutcome
): SessionApproval => ({
	...(isUndefined(decision) ? {} : { decision }),
	id,
	request: request(id.startsWith("call-") ? id : undefined),
	target: id.startsWith("call-") ? "tool-call" : "session",
});

test("projects each settlement decision into the panel's own outcome vocabulary", () => {
	const decisions: SessionApprovalOutcome[] = [
		{ decision: "allow", remember: false },
		{ decision: "allow", remember: true },
		{ decision: "reject", feedback: "use the config loader" },
		{ decision: "reject" },
		{ decision: "abort" },
	];

	const entries = projectSessionApprovals(
		[
			approval("call-1", decisions[0]),
			approval("call-2", decisions[1]),
			approval("call-3", decisions[2]),
			approval("call-4", decisions[3]),
			approval("call-5", decisions[4]),
		],
		() => undefined
	);

	expect(entries.map(({ resolution }) => resolution)).toEqual([
		{ outcome: "allow-once" },
		{ outcome: "always" },
		{ feedback: "use the config loader", outcome: "rejected" },
		{ outcome: "rejected" },
		{ outcome: "aborted" },
	]);
});

test("keeps a settled Tool Call approval and drops a settled session approval", () => {
	const entries = projectSessionApprovals(
		[
			approval("session-0", { decision: "reject" }),
			approval("session-1"),
			approval("call-1", { decision: "abort" }),
		],
		() => undefined
	);

	// The Tool Call entry stays so its message part can render an audit line; the
	// session entry has no timeline anchor and disappears once it settles.
	expect(entries.map(({ id }) => id)).toEqual(["session-1", "call-1"]);
});

test("routes every panel action through the session's approval command", () => {
	const respond = mock<(id: string, outcome: SessionApprovalOutcome) => void>(
		() => undefined
	);
	const [entry] = projectSessionApprovals([approval("call-1")], respond);
	const actions = entry?.actions;
	if (isUndefined(actions)) {
		throw new Error("The projection has no actions for a pending approval.");
	}

	actions.allow(false);
	actions.allow(true);
	actions.reject();
	actions.reject("use the config loader");
	actions.cancel();
	actions.abort();

	expect(respond.mock.calls).toEqual([
		["call-1", { decision: "allow", remember: false }],
		["call-1", { decision: "allow", remember: true }],
		["call-1", { decision: "reject" }],
		["call-1", { decision: "reject", feedback: "use the config loader" }],
		["call-1", { decision: "reject" }],
		["call-1", { decision: "abort" }],
	]);
});
