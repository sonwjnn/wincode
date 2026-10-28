import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import type { AgentTurnId } from "@wincode/agent-core";
import {
	createSessionSteeringWorkflow,
	type PendingSteeringDelivery,
	type SessionSteeringSnapshot,
	type SessionSteeringTransition,
} from "@/modules/sessions/agent-session/steering-workflow";
import type {
	SessionExecution,
	SessionSteeringMessage,
} from "@/modules/sessions/agent-session/types";
import type { SessionMessage } from "@/modules/sessions/message";
import {
	agentTurnId,
	sessionMessageId,
	sessionRecordId,
	steeringMessageId,
} from "../support/identifiers";

const steeringMessage = (id: string): SessionSteeringMessage =>
	fromPartial<SessionSteeringMessage>({
		id: steeringMessageId(id),
		input: {
			composition: { files: [], text: id },
			userText: id,
		},
		message: fromPartial<SessionMessage>({
			id: sessionMessageId(`message-${id}`),
			parts: [{ text: id, type: "text" }],
			role: "user",
		}),
		recordId: sessionRecordId(`record-${id}`),
		status: "pending",
	});

const deliveryOf = (
	turnId: AgentTurnId,
	index: number
): PendingSteeringDelivery => ({
	execution: fromPartial<SessionExecution>({ turnId }),
	message: fromPartial<SessionMessage>({ role: "user" }),
	source: steeringMessage(`steering-${turnId}-${index}`),
});

/**
 * One steering workflow over an in-memory state, so a test can watch which
 * transitions it proposes and which effects it asks for.
 */
const createSteeringFixture = ({
	outcome = { rejected: true, reason: "the turn refused it" },
	turnStarts = false,
}: Readonly<{
	outcome?: { rejected: true; reason: string } | { rejected: false };
	turnStarts?: boolean;
}> = {}) => {
	const pending = new Map<AgentTurnId, PendingSteeringDelivery[]>();
	const pendingStarts = new Map<AgentTurnId, SessionSteeringMessage>();
	let lane: readonly SessionSteeringMessage[] = [];
	const cleared: AgentTurnId[] = [];
	const settled: { id: string; reason?: string; status: string }[] = [];
	const events: { kind: string; reason?: string }[] = [];
	const proposed: SessionSteeringTransition[] = [];
	const runOptions: ({ reportFailure?: boolean } | undefined)[] = [];

	const workflow = createSessionSteeringWorkflow({
		apply: (transition: SessionSteeringTransition) => {
			proposed.push(transition);
			if (transition.kind === "start-armed") {
				pendingStarts.set(transition.turnId, transition.source);
				return;
			}
			if (transition.kind === "start-consumed") {
				pendingStarts.delete(transition.turnId);
				return;
			}
			if (transition.kind === "delivery-cleared") {
				cleared.push(transition.turnId);
				pending.delete(transition.turnId);
			}
		},
		effects: {
			attachments: { hydrate: async ({ messages }) => [...messages] },
			commitSteeringRecord: async () => undefined,
			emitSubmissionEvent: (event) => {
				events.push({
					kind: event.kind,
					...("reason" in event ? { reason: event.reason } : {}),
				});
			},
			resolveCompactionSettings: async () =>
				fromPartial({ enabled: false, keepRecentTokens: 1 }),
			resolveFileMentions: async () => [],
			resolveSubmission: (input) => input,
			runSteeringRetry: async (_retryingId, run) => await run(),
			runSubmission: async (input, options) => {
				runOptions.push(options);
				// The Session clears the arm once an Agent Turn begins, which is what tells
				// the workflow this Submission did start one. Requiring the delete to hit
				// something keeps a turn the workflow never armed from passing.
				if (
					turnStarts &&
					input.turnId !== undefined &&
					!pendingStarts.delete(input.turnId)
				) {
					throw new Error("The workflow did not arm the turn it is running.");
				}
				return outcome;
			},
			skills: { resolveSkill: async () => ({ ok: true }) },
			updateSteeringStatus: async (source, updated) => {
				settled.push({
					id: source.id,
					status: updated.status,
					...(updated.reason === undefined ? {} : { reason: updated.reason }),
				});
			},
		},
		read: (): SessionSteeringSnapshot => ({
			pending: new Map(pending),
			pendingStarts: new Map(pendingStarts),
			view: {
				context: [],
				steeringMessages: lane,
			},
		}),
		signals: () => ({ closed: () => false }),
	});

	return {
		/** Every transition the workflow proposed, in order. */
		proposed: () => proposed,
		runOptions,
		/** Makes the lane's head the message a run is about to be given. */
		setLane: (messages: readonly SessionSteeringMessage[]) => {
			lane = messages;
		},
		clearedTurns: () => cleared,
		events,
		pendingFor: (turnId: AgentTurnId) => pending.get(turnId) ?? [],
		settled,
		steeringMessage,
		turnWithDeliveries: (id: string, count: number) => {
			const turnId = agentTurnId(id);
			const deliveries = Array.from({ length: count }, (_, index) =>
				deliveryOf(turnId, index)
			);
			pending.set(turnId, deliveries);
			return {
				sourceIds: deliveries.map(({ source }) => source.id),
				turnId,
			};
		},
		workflow,
	};
};

test("acknowledging a turn settles its deliveries and clears only that turn", async () => {
	const fixture = createSteeringFixture();
	const finished = fixture.turnWithDeliveries("turn-finished", 2);
	const live = fixture.turnWithDeliveries("turn-live", 1);

	await fixture.workflow.acknowledge(finished.turnId, "processed");

	expect(fixture.settled).toEqual(
		finished.sourceIds.map((id) => ({ id, status: "processed" }))
	);
	expect(fixture.clearedTurns()).toEqual([finished.turnId]);
	expect(fixture.pendingFor(live.turnId)).toHaveLength(1);
	// Consumers learn of each settled delivery; the live turn's is not announced.
	expect(fixture.events).toEqual([
		{ kind: "processed" },
		{ kind: "processed" },
	]);
});

test("a committed Submission that did not start a turn is reported as a steering failure", async () => {
	const fixture = createSteeringFixture({ turnStarts: false });
	const message = fixture.steeringMessage("steering-unstarted");
	fixture.setLane([message]);

	const outcome = await fixture.workflow.runPendingMessage(message);

	expect(outcome).toEqual({
		rejected: true,
		reason: "the turn refused it",
	});
	expect(fixture.settled).toEqual([
		{ id: "steering-unstarted", status: "processing" },
		{
			id: "steering-unstarted",
			status: "failed",
			reason: "the turn refused it",
		},
	]);
	expect(fixture.events).toEqual([
		{ kind: "failed", reason: "the turn refused it" },
	]);
	// The steering path reports its own failure; the run must not report it again.
	expect(fixture.runOptions).toEqual([{ reportFailure: false }]);
	expect(
		fixture.proposed().filter(({ kind }) => kind === "message-published")
	).toHaveLength(1);
});

test("a Submission that started a turn is not reported as a steering failure", async () => {
	const fixture = createSteeringFixture({ turnStarts: true });
	const message = fixture.steeringMessage("steering-started");
	fixture.setLane([message]);

	const outcome = await fixture.workflow.runPendingMessage(message);

	// The turn's own outcome stands; steering does not overwrite it with a failure.
	expect(outcome).toEqual({ rejected: true, reason: "the turn refused it" });
	expect(fixture.settled).toEqual([
		{ id: "steering-started", status: "processing" },
	]);
	expect(fixture.events).toEqual([]);
});

test("a Submission that succeeded without starting a turn is still reported as a failure", async () => {
	const fixture = createSteeringFixture({
		outcome: { rejected: false },
		turnStarts: false,
	});
	const message = fixture.steeringMessage("steering-vanished");
	fixture.setLane([message]);

	const outcome = await fixture.workflow.runPendingMessage(message);

	// Without this the message would sit at "processing" forever, with no reason
	// for the user and no failed event.
	expect(outcome).toEqual({
		rejected: true,
		reason: "The committed Submission did not start an Agent Turn.",
	});
	expect(fixture.settled).toEqual([
		{ id: "steering-vanished", status: "processing" },
		{
			id: "steering-vanished",
			reason: "The committed Submission did not start an Agent Turn.",
			status: "failed",
		},
	]);
	expect(fixture.events).toEqual([
		{
			kind: "failed",
			reason: "The committed Submission did not start an Agent Turn.",
		},
	]);
});

test("a Steering Message that is not the lane head is refused without settling it", async () => {
	const fixture = createSteeringFixture();
	const head = fixture.steeringMessage("steering-head");
	const queued = fixture.steeringMessage("steering-behind-head");
	fixture.setLane([head, queued]);

	const outcome = await fixture.workflow.runPendingMessage(queued);

	// A live Session refuses the not-head case for its own reason; the shut-down
	// reason belongs to a closed one.
	expect(outcome).toEqual({
		rejected: true,
		reason: "The committed Submission is no longer waiting.",
	});
	expect(fixture.settled).toEqual([]);
	expect(fixture.events).toEqual([]);
});

test("acknowledging a turn with nothing pending settles nothing", async () => {
	const fixture = createSteeringFixture();

	await fixture.workflow.acknowledge(
		agentTurnId("turn-never-ran"),
		"processed"
	);

	expect(fixture.settled).toEqual([]);
	expect(fixture.clearedTurns()).toEqual([]);
	expect(fixture.events).toEqual([]);
});
