import { describe, expect, test } from "bun:test";
import type { AgentTurnEvent, AgentTurnTerminalEvent } from "./index";
import {
	AgentInvariantError,
	createAgentTurnLifecycle,
	getAgentTurnAbortDisposition,
	isOperationalFailure,
	normalizeOperationalFailure,
} from "./index";

const started: AgentTurnEvent = {
	agentId: "build",
	sequence: 0,
	startedAt: 1,
	turnId: "turn-1",
	type: "agent-turn-started",
};

const completed = (sequence: number): AgentTurnTerminalEvent => ({
	finishedAt: 2,
	sequence,
	turnId: "turn-1",
	type: "agent-turn-completed",
});

describe("Agent Turn lifecycle", () => {
	test("accepts every explicit terminal outcome", () => {
		for (const terminal of [
			completed(1),
			{
				failure: {
					code: "cancelled",
					message: "The Agent Turn was cancelled.",
					retry: "never",
					source: "runtime",
					version: 1,
				},
				finishedAt: 2,
				sequence: 1,
				turnId: "turn-1",
				type: "agent-turn-cancelled",
			},
			{
				failure: {
					code: "interrupted",
					message: "The Agent Turn was interrupted.",
					retry: "immediate",
					source: "runtime",
					version: 1,
				},
				finishedAt: 2,
				reason: "user",
				sequence: 1,
				turnId: "turn-1",
				type: "agent-turn-interrupted",
			},
		] satisfies AgentTurnTerminalEvent[]) {
			const lifecycle = createAgentTurnLifecycle("turn-1");
			lifecycle.apply(started);
			const state = lifecycle.apply(terminal);
			let expectedStatus: "cancelled" | "completed" | "interrupted";
			switch (terminal.type) {
				case "agent-turn-cancelled":
					expectedStatus = "cancelled";
					break;
				case "agent-turn-completed":
					expectedStatus = "completed";
					break;
				case "agent-turn-interrupted":
					expectedStatus = "interrupted";
					break;
				default:
					throw new Error("Unexpected terminal event.");
			}
			expect(state.status).toBe(expectedStatus);
			expect(state.terminalEvent).toBe(terminal);
		}
	});

	test("turns a stream ending without a terminal into lost-execution interruption", () => {
		const lifecycle = createAgentTurnLifecycle("turn-1");
		lifecycle.apply(started);
		const event = lifecycle.interrupt(1);

		expect(event).toMatchObject({
			failure: {
				code: "interrupted",
				retry: "immediate",
				source: "runtime",
			},
			reason: "lost-execution",
			type: "agent-turn-interrupted",
		});
		expect(lifecycle.getState().status).toBe("interrupted");
	});

	test("rejects a second terminal event as a typed invariant with a cause", () => {
		const lifecycle = createAgentTurnLifecycle("turn-1");
		lifecycle.apply(started);
		lifecycle.apply(completed(1));

		expect(() => lifecycle.apply(completed(2))).toThrow(AgentInvariantError);
		try {
			lifecycle.apply(completed(2));
		} catch (error) {
			expect(error).toBeInstanceOf(AgentInvariantError);
			expect((error as AgentInvariantError).cause).toBeDefined();
		}
	});
});

describe("Operational Failure boundary", () => {
	test("normalizes arbitrary causes to a safe allowlisted failure", () => {
		const failure = normalizeOperationalFailure(
			new Error("provider body contains secret-token"),
			{ modelId: "gpt-5.4-mini", providerId: "openai" }
		);

		expect(failure).toEqual({
			code: "unknown",
			details: { modelId: "gpt-5.4-mini", providerId: "openai" },
			message: "The model request failed.",
			retry: "never",
			source: "runtime",
			version: 1,
		});
		expect(JSON.stringify(failure)).not.toContain("secret-token");
		expect(isOperationalFailure(failure)).toBe(true);
	});

	test("rejects details outside the allowlist", () => {
		expect(
			isOperationalFailure({
				code: "unknown",
				details: {
					responseBody: "secret-provider-body",
				},
				message: "raw",
				retry: "never",
				source: "runtime",
				version: 1,
			})
		).toBe(false);
		const normalized = normalizeOperationalFailure({
			code: "unknown",
			details: {
				responseBody: "secret-provider-body",
			},
			message: "raw",
			retry: "never",
			source: "runtime",
			version: 1,
		});
		expect(JSON.stringify(normalized)).not.toContain("secret-provider-body");
	});
	test("distinguishes caller cancellation, interruption, and deadline reasons", () => {
		expect(
			getAgentTurnAbortDisposition({
				type: "wincode-agent-turn",
				outcome: "cancelled",
			})
		).toBe("cancelled");
		expect(
			getAgentTurnAbortDisposition({
				type: "wincode-agent-turn",
				outcome: "interrupted",
			})
		).toBe("interrupted");
		expect(
			getAgentTurnAbortDisposition(
				new DOMException("deadline expired", "TimeoutError")
			)
		).toBe("deadline-exceeded");
	});
});
