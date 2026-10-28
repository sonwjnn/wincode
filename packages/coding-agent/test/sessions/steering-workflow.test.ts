import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import { type AgentTurnId, toSubmissionId } from "@wincode/agent-core";
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

const steeringMessage = (
	id: string,
	status: SessionSteeringMessage["status"] = "pending"
): SessionSteeringMessage =>
	fromPartial<SessionSteeringMessage>({
		id: steeringMessageId(id),
		input: {
			composition: { files: [], text: id },
			submissionId: toSubmissionId(`submission-${id}`),
			userText: id,
		},
		message: fromPartial<SessionMessage>({
			id: sessionMessageId(`message-${id}`),
			parts: [{ text: id, type: "text" }],
			role: "user",
		}),
		recordId: sessionRecordId(`record-${id}`),
		status,
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
	closed = false,
	outcome = { rejected: true, reason: "the turn refused it" },
	runThrows,
	turnStarts = false,
}: Readonly<{
	closed?: boolean;
	outcome?: { rejected: true; reason: string } | { rejected: false };
	runThrows?: unknown;
	turnStarts?: boolean;
}> = {}) => {
	const pending = new Map<AgentTurnId, PendingSteeringDelivery[]>();
	const pendingStarts = new Map<AgentTurnId, SessionSteeringMessage>();
	let lane: readonly SessionSteeringMessage[] = [];
	const cleared: AgentTurnId[] = [];
	const settled: {
		afterId?: string;
		id: string;
		reason?: string;
		status: string;
	}[] = [];
	const events: {
		kind: string;
		messageId?: string;
		reason?: string;
		submissionId?: string;
		turnId?: string;
	}[] = [];
	const proposed: SessionSteeringTransition[] = [];
	const runOptions: ({ reportFailure?: boolean } | undefined)[] = [];
	const runTurnIds: (AgentTurnId | undefined)[] = [];

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
					...("messageId" in event ? { messageId: event.messageId } : {}),
					...("submissionId" in event
						? { submissionId: event.submissionId }
						: {}),
					...("reason" in event ? { reason: event.reason } : {}),
					...("turnId" in event ? { turnId: event.turnId } : {}),
				});
			},
			resolveCompactionSettings: async () =>
				fromPartial({ enabled: false, keepRecentTokens: 1 }),
			resolveFileMentions: async () => [],
			resolveSubmission: (input) => input,
			runSteeringRetry: async (_retryingId, run) => await run(),
			runSubmission: async (input, options) => {
				runOptions.push(options);
				runTurnIds.push(input.turnId);
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
				if (runThrows !== undefined) {
					throw runThrows;
				}
				return outcome;
			},
			skills: { resolveSkill: async () => ({ ok: true }) },
			updateSteeringStatus: async (source, updated, afterId) => {
				settled.push({
					...(afterId === undefined ? {} : { afterId }),
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
		signals: () => ({ closed: () => closed }),
	});

	return {
		/** Every transition the workflow proposed, in order. */
		pendingStartCount: () => pendingStarts.size,
		proposed: () => proposed,
		runOptions,
		runTurnIds,
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
				messageIds: deliveries.map(({ source }) => source.message.id),
				submissionIds: deliveries.map(
					({ source }) => source.input.submissionId
				),
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
	// Each announcement names its own delivery: consumers attribute a settlement by
	// message id, so echoing one delivery's id twice would settle the wrong message.
	expect(fixture.events).toEqual(
		finished.messageIds.map((messageId, index) => ({
			kind: "processed",
			messageId,
			submissionId: finished.submissionIds[index],
			turnId: finished.turnId,
		}))
	);
});

test("acknowledging a turn as failed chains the retry order and names the reason", async () => {
	const fixture = createSteeringFixture();
	const failed = fixture.turnWithDeliveries("turn-failed", 3);
	const [firstId, secondId, thirdId] = failed.sourceIds;
	if (
		firstId === undefined ||
		secondId === undefined ||
		thirdId === undefined
	) {
		throw new Error("The fixture did not create all three deliveries.");
	}

	await fixture.workflow.acknowledge(failed.turnId, "failed");

	// A shut-down turn supplies no reason, so the confirmation failure stands in;
	// each later failure stacks behind the previous one so retry order is kept.
	expect(fixture.settled).toEqual([
		{
			id: firstId,
			reason: "The Agent Turn ended before confirming the Submission.",
			status: "failed",
		},
		{
			afterId: firstId,
			id: secondId,
			reason: "The Agent Turn ended before confirming the Submission.",
			status: "failed",
		},
		{
			afterId: secondId,
			id: thirdId,
			reason: "The Agent Turn ended before confirming the Submission.",
			status: "failed",
		},
	]);
	// A failed acknowledge must announce failures, not recycle another status.
	expect(fixture.events).toEqual(
		failed.messageIds.map((messageId, index) => ({
			kind: "failed",
			messageId,
			reason: "The Agent Turn ended before confirming the Submission.",
			submissionId: failed.submissionIds[index],
			turnId: failed.turnId,
		}))
	);
	expect(fixture.clearedTurns()).toEqual([failed.turnId]);
});

test("a Steering Message already past pending is not run again", async () => {
	const fixture = createSteeringFixture();
	const settledElsewhere = fixture.steeringMessage(
		"steering-processing",
		"processing"
	);
	fixture.setLane([settledElsewhere]);

	const outcome = await fixture.workflow.runPendingMessage(settledElsewhere);

	// Re-running it would deliver a Submission the lane already handled.
	expect(outcome).toEqual({
		rejected: true,
		reason: "The committed Submission is no longer waiting.",
	});
	expect(fixture.settled).toEqual([]);
	expect(fixture.events).toEqual([]);
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
		{
			kind: "failed",
			messageId: message.message.id,
			reason: "the turn refused it",
			submissionId: message.input.submissionId,
			// The workflow mints the turn, so pin the identity it actually ran.
			turnId: fixture.runTurnIds[0],
		},
	]);
	// Taking the arm has to clear it, or the next look would see it still armed.
	expect(fixture.pendingStartCount()).toBe(0);
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
			messageId: message.message.id,
			reason: "The committed Submission did not start an Agent Turn.",
			submissionId: message.input.submissionId,
			turnId: fixture.runTurnIds[0],
		},
	]);
});

test("a run that throws after arming the turn is reported as a steering failure", async () => {
	const fixture = createSteeringFixture({
		runThrows: new Error("the run blew up"),
		turnStarts: false,
	});
	const message = fixture.steeringMessage("steering-threw");
	fixture.setLane([message]);

	const outcome = await fixture.workflow.runPendingMessage(message);

	// The Submission may have reached the provider, so the failure is recorded
	// against it rather than escaping as an unhandled error.
	expect(outcome).toEqual({ rejected: true, reason: "the run blew up" });
	expect(fixture.settled).toEqual([
		{ id: "steering-threw", status: "processing" },
		{ id: "steering-threw", reason: "the run blew up", status: "failed" },
	]);
	expect(fixture.events).toEqual([
		{
			kind: "failed",
			messageId: message.message.id,
			reason: "the run blew up",
			submissionId: message.input.submissionId,
			turnId: fixture.runTurnIds[0],
		},
	]);
});

test("a retry that arrives after the session ended is refused for that reason", async () => {
	// The lane checks the Session is open before it retries, then awaits the
	// selection validation, so that check can go stale. Steering must refuse on
	// its own rather than commit against a closed Session.
	const fixture = createSteeringFixture({ closed: true });
	const message = fixture.steeringMessage("steering-after-shutdown", "failed");
	fixture.setLane([message]);

	const outcome = await fixture.workflow.retryFailedMessage(message);

	expect(outcome).toEqual({
		rejected: true,
		reason: "The session has ended.",
	});
	expect(fixture.settled).toEqual([]);
	expect(fixture.events).toEqual([]);
});

test("a run that throws after the turn started rethrows instead of claiming a steering failure", async () => {
	const fixture = createSteeringFixture({
		runThrows: new Error("the run blew up"),
		turnStarts: true,
	});
	const message = fixture.steeringMessage("steering-rethrown");
	fixture.setLane([message]);

	// The turn ran, so its own failure is the one that counts; steering must not
	// overwrite it with a "never started" reason.
	await expect(fixture.workflow.runPendingMessage(message)).rejects.toThrow(
		"the run blew up"
	);
	expect(fixture.settled).toEqual([
		{ id: "steering-rethrown", status: "processing" },
	]);
	expect(fixture.events).toEqual([]);
});

test("a run that throws a non-error still reports the confirmation failure", async () => {
	const fixture = createSteeringFixture({ runThrows: {}, turnStarts: false });
	const message = fixture.steeringMessage("steering-opaque-throw");
	fixture.setLane([message]);

	const outcome = await fixture.workflow.runPendingMessage(message);

	// A thrown value with no message cannot explain itself, so the fallback stands.
	expect(outcome).toEqual({
		rejected: true,
		reason: "The committed Submission did not start an Agent Turn.",
	});
	expect(fixture.settled.at(-1)).toEqual({
		id: "steering-opaque-throw",
		reason: "The committed Submission did not start an Agent Turn.",
		status: "failed",
	});
});

test("a Steering Message that is not the lane head is refused without settling it", async () => {
	const fixture = createSteeringFixture();
	const head = fixture.steeringMessage("steering-head");
	const queued = fixture.steeringMessage("steering-behind-head");
	fixture.setLane([head, queued]);

	const outcome = await fixture.workflow.runPendingMessage(queued);

	// A live Session refuses the not-head case for its own reason.
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
