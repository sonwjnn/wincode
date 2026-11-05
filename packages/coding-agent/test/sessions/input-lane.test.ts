import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import {
	createSessionInputLaneWorkflow,
	type SessionInputLanePort,
	type SessionInputLaneSnapshot,
	type SessionInputLaneTransition,
} from "@/modules/sessions/agent-session/input-lane";
import type { SessionSendInput } from "@/modules/sessions/submission-types";
import { createTestInputScheduler } from "../support/stateful-agent";

/**
 * A lane state consistent with the conditions this fixture models: `canDrain`
 * is derived, not chosen, and holds only while execution and persistence are
 * ready. Production also stops a drain while a submission transition is pending,
 * which is not modelled because no test here publishes that state.
 */
const laneState = (
	overrides: Omit<Partial<SessionInputLaneSnapshot["lane"]>, "canDrain"> = {}
): SessionInputLaneSnapshot["lane"] => {
	const base = {
		closed: false,
		executionBusy: false,
		queueDraining: false,
		reconciliationRequired: false,
		submissionBusy: false,
		writeBlocked: false,
		...overrides,
	};
	return {
		...base,
		canDrain: !(
			base.executionBusy ||
			base.reconciliationRequired ||
			base.writeBlocked
		),
	};
};

const snapshotOf = ({
	lane = laneState(),
	...overrides
}: Partial<SessionInputLaneSnapshot> = {}): SessionInputLaneSnapshot => ({
	externalizations: new Map(),
	lane,
	steeringMessages: [],
	...overrides,
});

const sendInput = (userText: string, attachmentId?: string): SessionSendInput =>
	fromPartial<SessionSendInput>({
		userText,
		...(attachmentId === undefined
			? {}
			: {
					composition: {
						files: [{ attachmentId, type: "file" }],
						text: userText,
					},
				}),
	});

type LaneOptions = Readonly<{
	onRunSubmission?: (
		input: SessionSendInput,
		update: (patch: Partial<SessionInputLaneSnapshot>) => void
	) => void | Promise<void>;
}>;

/** One input lane whose read surface a test can advance, and which records writes. */
const createLane = (
	initial: SessionInputLaneSnapshot = snapshotOf(),
	options: LaneOptions = {}
) => {
	let state = initial;
	const applied: SessionInputLaneTransition[] = [];
	const runs: SessionSendInput[] = [];
	const releasedAttachmentIds: string[] = [];
	const tracked: Promise<unknown>[] = [];
	const scheduler = createTestInputScheduler();
	const updateState = (patch: Partial<SessionInputLaneSnapshot>): void => {
		state = { ...state, ...patch };
	};

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
			externalizeAttachments: async (messages) => ({
				messages: [...messages],
				release: async () => undefined,
			}),
			releaseAttachments: (attachmentIds) => {
				releasedAttachmentIds.push(...attachmentIds);
			},
			reportSubmissionFailure: () => undefined,
			retainAttachments: () => undefined,
			retrySteeringMessage: async () => ({ rejected: true, reason: "retry" }),
			runSteeringMessage: async () => ({ rejected: true, reason: "steering" }),
			runSubmission: async (input) => {
				runs.push(input);
				await options.onRunSubmission?.(input, updateState);
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
		releasedAttachmentIds,
		runs,
		scheduler,
		update: updateState,
	};
};

test("a Submission to an ended session is rejected before the scheduler sees it", async () => {
	const lane = createLane(snapshotOf({ lane: laneState({ closed: true }) }));

	const admission = await lane.lane.prompt(sendInput("after shutdown"));

	expect(admission).toEqual({
		rejected: true,
		reason: "The session has ended.",
	});
	expect(lane.scheduler.getQueuedSubmissions()).toHaveLength(0);
	expect(lane.applied).toEqual([]);
});

test("a Submission admitted while the session is busy is queued, not started", async () => {
	// A busy lane still holds a live turn, so it cannot drain either.
	const lane = createLane(
		snapshotOf({
			lane: laneState({ executionBusy: true, submissionBusy: true }),
		})
	);

	const admission = await lane.lane.prompt(sendInput("while busy"));
	await lane.settle();

	const [queued] = lane.scheduler.getQueuedSubmissions();
	expect(admission).toMatchObject({ disposition: "queued", rejected: false });
	expect(lane.runs).toEqual([]);
	// The admission must name the same Submission the scheduler holds, or the
	// optimistic UI message would be orphaned from the queued record.
	expect(queued).toBeDefined();
	if (admission.rejected || queued === undefined) {
		throw new Error("The busy session did not queue the Submission.");
	}
	expect(admission.messageId).toBe(queued.messageId);
	expect(admission.submissionId).toBe(queued.submissionId);
});

test("a Submission is queued on the queueing flag alone, not on a busy execution", async () => {
	// Work can be queued while nothing is executing; the queueing gate is what
	// decides, so a Submission must not jump ahead of the FIFO head here.
	const lane = createLane(
		snapshotOf({ lane: laneState({ submissionBusy: true }) })
	);

	const admission = await lane.lane.prompt(sendInput("behind the head"));

	// Only the queueing flag decides this: gating on a busy execution instead
	// would start the Submission ahead of the FIFO head, reporting "started".
	expect(admission).toMatchObject({ disposition: "queued", rejected: false });
	await lane.settle();
});

test("Recall keeps a queued head reserved until an indeterminate write is reconciled", async () => {
	const lane = createLane(
		snapshotOf({
			lane: laneState({ executionBusy: true, submissionBusy: true }),
		})
	);
	await lane.lane.prompt(sendInput("input awaiting reconciliation"));
	await lane.settle();
	const queuedBeforeReconciliation = lane.scheduler.getQueuedSubmissions();
	const transitionsBeforeRecall = lane.applied.length;
	lane.update({
		lane: laneState({ reconciliationRequired: true, writeBlocked: true }),
	});

	const recalled = await lane.lane.recallWaitingMessages();

	expect(recalled).toEqual([]);
	expect(lane.scheduler.getQueuedSubmissions()).toEqual(
		queuedBeforeReconciliation
	);
	expect(lane.applied).toHaveLength(transitionsBeforeRecall);
});

test("draining stops before the next queue head after an indeterminate write blocks storage", async () => {
	const lane = createLane(
		snapshotOf({
			lane: laneState({ executionBusy: true, submissionBusy: true }),
		}),
		{
			onRunSubmission: (_input, update) => {
				update({
					lane: laneState({
						reconciliationRequired: true,
						writeBlocked: true,
					}),
				});
			},
		}
	);
	const first = await lane.lane.prompt(
		sendInput("current queued head", "attachment-current")
	);
	const second = await lane.lane.prompt(
		sendInput("later queue head", "attachment-later")
	);
	await lane.settle();
	if (first.rejected || second.rejected) {
		throw new Error("The test Submissions were not queued.");
	}
	expect(lane.scheduler.getQueuedSubmissions()).toHaveLength(2);

	lane.update({ lane: laneState() });
	await lane.lane.drainQueuedSubmissions();

	expect(lane.runs.map(({ userText }) => userText)).toEqual([
		"current queued head",
	]);
	expect(lane.scheduler.getQueuedSubmissions()).toMatchObject([
		{ messageId: second.messageId, submissionId: second.submissionId },
	]);
	expect(lane.releasedAttachmentIds).toEqual(["attachment-current"]);
});

test("steer on a closed session is refused without committing a Submission", async () => {
	const lane = createLane(snapshotOf({ lane: laneState({ closed: true }) }));

	const admission = await lane.lane.steer();

	expect(admission).toEqual({
		kind: "rejected",
		reason: "The session has ended.",
	});
	expect(lane.applied).toEqual([]);
	expect(lane.scheduler.getQueuedSubmissions()).toHaveLength(0);
});

test("steer on an empty queue reports an empty queue without writing anything", async () => {
	const lane = createLane();

	const admission = await lane.lane.steer();

	// `empty` is silent for the composer; `rejected` renders an error toast.
	expect(admission).toEqual({ kind: "empty" });
	expect(lane.applied).toEqual([]);
	expect(lane.scheduler.getQueuedSubmissions()).toHaveLength(0);
});
