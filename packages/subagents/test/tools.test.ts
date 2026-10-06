import { expect, test } from "bun:test";
import {
	AgentInvariantError,
	type AgentTurnId,
	type ToolCallId,
} from "@wincode/agent-core";
import { createSubagentTools } from "../src/index";

const parentTurnId = "turn-parent" as AgentTurnId;
const toolCallId = "call-delegate" as ToolCallId;

test("delegate returns the durable child identity without waiting for its result", async () => {
	let capturedRequest:
		| {
				agent: string;
				parentToolCallId: ToolCallId;
				parentTurnId: AgentTurnId;
				prompt: string;
		  }
		| undefined;
	const tools = createSubagentTools({
		delegate: async (request) => {
			capturedRequest = request;
			return {
				childSessionId: "session-child",
				status: "active",
				taskId: "task-1",
			};
		},
		parentTurnId,
	});
	const delegate = tools.find(
		({ definition }) => definition.name === "delegate"
	);
	expect(delegate).toBeDefined();

	const output = await delegate?.execute(
		{ input: { agent: "worker", prompt: "Inspect the failure" }, toolCallId },
		{}
	);

	expect(capturedRequest).toEqual({
		agent: "worker",
		parentToolCallId: toolCallId,
		parentTurnId,
		prompt: "Inspect the failure",
	});
	expect(output).toEqual({
		output: {
			childSessionId: "session-child",
			status: "active",
			taskId: "task-1",
		},
		type: "success",
	});
});

test("invalid delegate input fails without creating a child task", async () => {
	let calls = 0;
	const tools = createSubagentTools({
		delegate: async () => {
			calls += 1;
			return {
				childSessionId: "session-child",
				status: "active",
				taskId: "task-1",
			};
		},
		parentTurnId,
	});
	const delegate = tools.find(
		({ definition }) => definition.name === "delegate"
	);
	expect(delegate).toBeDefined();

	const output = await delegate?.execute(
		{ input: { agent: "worker", prompt: "" }, toolCallId },
		{}
	);

	expect(output).toMatchObject({ type: "failure" });
	expect(calls).toBe(0);
});

test("submit_result ACK stops its Agent Turn only after durable acceptance", async () => {
	const reports: { details?: string; summary: string }[] = [];
	const tools = createSubagentTools({
		delegationTaskId: "task-1",
		submitResult: async (report) => {
			reports.push(report);
			return true;
		},
	});
	const submitResult = tools.find(
		({ definition }) => definition.name === "submit_result"
	);
	expect(submitResult?.definition.exclusiveInBatch).toBe(true);

	const output = await submitResult?.execute(
		{
			input: { summary: "Completed", details: "Verified the fix" },
			toolCallId,
		},
		{}
	);

	expect(reports).toEqual([
		{ summary: "Completed", details: "Verified the fix" },
	]);
	expect(output).toEqual({
		output: { status: "succeeded", taskId: "task-1" },
		stopTurn: true,
		type: "success",
	});
});

test("partial parent or child contexts cannot expose mismatched Subagent tools", () => {
	expect(() =>
		createSubagentTools({
			delegate: async () => ({
				childSessionId: "session-child",
				status: "active",
				taskId: "task-1",
			}),
		})
	).toThrow(AgentInvariantError);
	expect(() => createSubagentTools({ delegationTaskId: "task-1" })).toThrow(
		AgentInvariantError
	);
});

test("rejected submit_result does not report success or stop its Agent Turn", async () => {
	let calls = 0;
	const tools = createSubagentTools({
		delegationTaskId: "task-1",
		submitResult: async () => {
			calls += 1;
			return false;
		},
	});
	const submitResult = tools.find(
		({ definition }) => definition.name === "submit_result"
	);
	expect(submitResult).toBeDefined();

	const output = await submitResult?.execute(
		{ input: { summary: "Completed" }, toolCallId },
		{}
	);

	expect(calls).toBe(1);
	expect(output).toMatchObject({ type: "failure" });
	expect(output).not.toHaveProperty("stopTurn");
});
