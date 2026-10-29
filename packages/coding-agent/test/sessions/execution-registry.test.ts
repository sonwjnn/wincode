import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import type { AgentTurnId } from "@wincode/agent-core";
import { createExecutionRegistry } from "@/modules/sessions/agent-session/execution-registry";
import type { SessionExecution } from "@/modules/sessions/agent-session/types";
import { agentTurnId, sessionMessageId } from "../support/identifiers";

const executionOf = (
	turnId: AgentTurnId,
	assistantId: string
): SessionExecution =>
	fromPartial<SessionExecution>({
		assistantId: sessionMessageId(assistantId),
		turnId,
	});

test("every caller waiting for one execution's end resolves", async () => {
	const registry = createExecutionRegistry({ isLive: () => true });
	const turnId = agentTurnId("turn-many-waiters");
	const woken: number[] = [];

	const waiting = [0, 1, 2].map((index) =>
		registry.waitForEnd(turnId).then(() => {
			woken.push(index);
		})
	);
	await Bun.sleep(0);
	expect(woken).toEqual([]);

	registry.end(turnId);
	await Promise.all(waiting);

	expect(woken).toEqual([0, 1, 2]);
});

test("reassigning an execution that ended without retention changes nothing", () => {
	const registry = createExecutionRegistry({ isLive: () => true });
	const turnId = agentTurnId("turn-not-retained");

	registry.end(turnId, executionOf(turnId, "assistant-dropped"));
	registry.end(turnId);
	registry.reassignAssistantId(turnId, sessionMessageId("assistant-late"));

	expect(registry.assistantIdFor(turnId)).toBeUndefined();
});

test("a retained execution is filed under its own turn, not the caller's", () => {
	const registry = createExecutionRegistry({ isLive: () => true });
	const askedFor = agentTurnId("turn-asked");
	const owned = agentTurnId("turn-owned");

	registry.end(askedFor, executionOf(owned, "assistant-owned"));

	expect(registry.assistantIdFor(owned)).toBe(
		sessionMessageId("assistant-owned")
	);
	expect(registry.assistantIdFor(askedFor)).toBeUndefined();
});

test("a caller waiting for an execution's end resolves when it ends", async () => {
	const registry = createExecutionRegistry({ isLive: () => true });
	const turnId = agentTurnId("turn-waited");
	let ended = false;

	const waiting = registry.waitForEnd(turnId).then(() => {
		ended = true;
	});
	await Bun.sleep(0);
	expect(ended).toBe(false);

	registry.end(turnId);
	await waiting;

	expect(ended).toBe(true);
});

test("a retained execution still reports its assistant message after its live end", () => {
	const registry = createExecutionRegistry({ isLive: () => true });
	const turnId = agentTurnId("turn-retained");

	registry.end(turnId, executionOf(turnId, "assistant-retained"));

	expect(registry.assistantIdFor(turnId)).toBe(
		sessionMessageId("assistant-retained")
	);
});

test("an execution that ends without retention reports no assistant message", () => {
	const registry = createExecutionRegistry({ isLive: () => true });
	const turnId = agentTurnId("turn-forgotten");

	registry.end(turnId, executionOf(turnId, "assistant-first"));
	registry.end(turnId);

	expect(registry.assistantIdFor(turnId)).toBeUndefined();
});

test("reassigning a retained execution re-points the assistant message that replaced it", () => {
	const registry = createExecutionRegistry({ isLive: () => true });
	const turnId = agentTurnId("turn-reassigned");

	registry.end(turnId, executionOf(turnId, "assistant-first"));
	registry.reassignAssistantId(turnId, sessionMessageId("assistant-second"));

	expect(registry.assistantIdFor(turnId)).toBe(
		sessionMessageId("assistant-second")
	);
});

test("waiting on a turn that never ran resolves instead of hanging", async () => {
	const registry = createExecutionRegistry({ isLive: () => false });

	const outcome = await registry.waitForEnd(agentTurnId("turn-unknown")).then(
		() => "resolved" as const,
		() => "rejected" as const
	);

	expect(outcome).toBe("resolved");
});
