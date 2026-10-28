import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import {
	createSessionInputLaneWorkflow,
	type SessionInputLanePort,
	type SessionInputLaneSnapshot,
	type SessionInputLaneTransition,
} from "@/modules/sessions/agent-session/input-lane";
import { SESSION_SHUT_DOWN_ERROR } from "@/modules/sessions/agent-session/session-messages";
import type { SessionSendInput } from "@/modules/sessions/submission-types";
import { createTestInputScheduler } from "../support/stateful-agent";

const laneState = (
	overrides: Partial<SessionInputLaneSnapshot["lane"]> = {}
): SessionInputLaneSnapshot["lane"] => ({
	canDrain: true,
	closed: false,
	executionBusy: false,
	queueDraining: false,
	submissionBusy: false,
	...overrides,
});

const snapshotOf = ({
	lane = laneState(),
	...overrides
}: Partial<SessionInputLaneSnapshot> = {}): SessionInputLaneSnapshot => ({
	externalizations: new Map(),
	lane,
	steeringMessages: [],
	...overrides,
});

const sendInput = (userText: string): SessionSendInput =>
	fromPartial<SessionSendInput>({ userText });

/** One input lane whose read surface a test can advance, and which records writes. */
const createLane = (initial: SessionInputLaneSnapshot = snapshotOf()) => {
	let state = initial;
	const applied: SessionInputLaneTransition[] = [];
	const runs: SessionSendInput[] = [];
	const tracked: Promise<unknown>[] = [];
	const scheduler = createTestInputScheduler();

	const port: SessionInputLanePort = {
		apply: (transition) => {
			applied.push(transition);
			if (transition.kind === "externalization-added") {
				const next = new Map(state.externalizations);
				next.set(transition.id, {
					completion: transition.completion,
					controller: transition.controller,
				});
				state = { ...state, externalizations: next };
			}
			if (transition.kind === "externalization-removed") {
				const next = new Map(state.externalizations);
				next.delete(transition.id);
				state = { ...state, externalizations: next };
			}
			if (transition.kind === "queue-draining-set") {
				state = {
					...state,
					lane: { ...state.lane, queueDraining: transition.draining },
				};
			}
		},
		effects: {
			assertSubmissionSelection: () => undefined,
			commitSteeringSubmission: async () => fromPartial({ kind: "rejected" }),
			completeSteeringSubmission: () => undefined,
			emitSubmissionEvent: () => undefined,
			externalizeAttachments: async (messages) => [...messages],
			releaseAttachments: () => undefined,
			reportSubmissionFailure: () => undefined,
			retainAttachments: () => undefined,
			retrySteeringMessage: async () => ({ rejected: true, reason: "retry" }),
			runSteeringMessage: async () => ({ rejected: true, reason: "steering" }),
			runSubmission: async (input) => {
				runs.push(input);
				return { rejected: false };
			},
			trackBackgroundTask: (task) => {
				tracked.push(task);
			},
		},
		inputScheduler: scheduler,
		read: () => state,
	};

	return {
		applied,
		lane: createSessionInputLaneWorkflow(port),
		/** Waits for the admissions the lane deferred to the background. */
		settle: () => Promise.allSettled(tracked),
		runs,
		scheduler,
		update: (patch: Partial<SessionInputLaneSnapshot>) => {
			state = { ...state, ...patch };
		},
	};
};

test("a Submission to an ended session is rejected before the scheduler sees it", async () => {
	const lane = createLane(snapshotOf({ lane: laneState({ closed: true }) }));

	const admission = await lane.lane.prompt(sendInput("after shutdown"));

	expect(admission).toEqual({
		rejected: true,
		reason: SESSION_SHUT_DOWN_ERROR,
	});
	expect(lane.scheduler.getQueuedSubmissions()).toHaveLength(0);
	expect(lane.applied).toEqual([]);
});

test("a Submission admitted while the session is busy is queued, not started", async () => {
	const lane = createLane(
		snapshotOf({ lane: laneState({ submissionBusy: true }) })
	);

	const admission = await lane.lane.prompt(sendInput("while busy"));

	expect(admission).toMatchObject({ disposition: "queued", rejected: false });
	expect(lane.runs).toEqual([]);
	expect(lane.scheduler.getQueuedSubmissions()).toHaveLength(1);
});

test("steer on an empty queue is rejected without writing anything", async () => {
	const lane = createLane();

	const admission = await lane.lane.steer();

	expect(admission.kind).not.toBe("steered");
	expect(lane.applied).toEqual([]);
	expect(lane.scheduler.getQueuedSubmissions()).toHaveLength(0);
});
