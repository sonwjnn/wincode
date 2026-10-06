import { expect, test } from "bun:test";
import type {
	DelegationReportEnvelope,
	DelegationTask,
} from "@/modules/sessions/delegation/types";
import type { SessionHost } from "@/modules/sessions/host/types";
import { createSubagentTaskRuntime } from "@/plugins/subagents/task-runtime";
import { toDelegationTaskId } from "@/shared/identifiers";
import {
	agentId,
	agentTurnId,
	sessionId,
	toolCallId,
} from "../../support/identifiers";

test("a report committed while the parent host opens is delivered after registration", () => {
	const parentSessionId = sessionId("parent-session");
	const childSessionId = sessionId("child-session");
	const taskId = toDelegationTaskId("task-1");
	const outcome = { kind: "result", report: { summary: "Finished" } } as const;
	const report: DelegationReportEnvelope = {
		childSessionId,
		createdAt: new Date(0),
		outcome,
		parentSessionId,
		parentToolCallId: toolCallId("delegate-call"),
		parentTurnId: agentTurnId("parent-turn"),
		taskId,
	};
	const task: DelegationTask = {
		agentId: agentId("build"),
		childSessionId,
		createdAt: report.createdAt,
		id: taskId,
		outcome,
		parentSessionId,
		parentToolCallId: report.parentToolCallId,
		parentTurnId: report.parentTurnId,
		status: "succeeded",
		updatedAt: report.createdAt,
	};
	const runtime = createSubagentTaskRuntime({
		emitTaskEvent: () => undefined,
		requestHostUnload: () => undefined,
	});
	const publishedReports: DelegationReportEnvelope[] = [];
	const host = {
		publishDelegationReport: (value: DelegationReportEnvelope) => {
			publishedReports.push(value);
		},
	} as unknown as SessionHost;

	runtime.onHostOpening(parentSessionId);
	runtime.publishTask(task, report);
	expect(publishedReports).toEqual([]);

	runtime.onHostOpened(parentSessionId, host);
	expect(publishedReports).toEqual([report]);
});
