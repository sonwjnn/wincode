import type { SessionId } from "@/shared/identifiers";
import type { SessionHost, SessionHostManager } from "./host/types";
import type {
	SessionForkCheckpoint,
	SessionForkResult,
	SessionStore,
} from "./storage/session-store";

type SessionForkGate = SessionHostManager["withIdleForSessionFork"];

const forkWithHost = (
	forkHost: SessionHost | undefined,
	store: Pick<SessionStore, "forkSession">,
	sourceSessionId: SessionId,
	checkpoint: SessionForkCheckpoint,
	operationId: string
): Promise<SessionForkResult> =>
	forkHost === undefined
		? store.forkSession(sourceSessionId, checkpoint, operationId)
		: forkHost.forkSession(checkpoint, operationId);

/** Keeps the source idle gate held until work after fork publication completes. */
export const forkSessionThroughIdleHostAndThen = <Result>(
	withIdleForSessionFork: SessionForkGate,
	store: Pick<SessionStore, "forkSession">,
	sourceSessionId: SessionId,
	checkpoint: SessionForkCheckpoint,
	operationId: string,
	afterFork: (result: SessionForkResult) => Promise<Result>
): Promise<Result> =>
	withIdleForSessionFork(sourceSessionId, async (forkHost) =>
		afterFork(
			await forkWithHost(
				forkHost,
				store,
				sourceSessionId,
				checkpoint,
				operationId
			)
		)
	);

/** Routes every Session Fork through the same idle-Host admission policy. */
export const forkSessionThroughIdleHost = (
	withIdleForSessionFork: SessionForkGate,
	store: Pick<SessionStore, "forkSession">,
	sourceSessionId: SessionId,
	checkpoint: SessionForkCheckpoint,
	operationId: string
): Promise<SessionForkResult> =>
	withIdleForSessionFork(sourceSessionId, (forkHost) =>
		forkWithHost(forkHost, store, sourceSessionId, checkpoint, operationId)
	);
