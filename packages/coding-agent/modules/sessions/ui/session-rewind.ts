import type { SessionId } from "@/shared/identifiers";
import type { SessionSdkForkResult } from "../sdk-contract";

type DisposableSessionForkResult = Pick<SessionSdkForkResult, "id"> &
	Readonly<{
		handle: Pick<SessionSdkForkResult["handle"], "dispose">;
	}>;

export type SessionRewindAction = Readonly<{
	complete: () => Promise<void>;
	sessionId: SessionId;
}>;

/** Releases the temporary child view before the caller completes or routes. */
export const createSessionForkAction = async ({
	complete,
	createFork,
}: Readonly<{
	complete: () => Promise<void>;
	createFork: () => Promise<DisposableSessionForkResult>;
}>): Promise<SessionRewindAction> => {
	const result = await createFork();
	const sessionId = result.id;
	await result.handle.dispose();
	return { complete, sessionId };
};

/** Publishes the fork before changing the active Session view. */
export const rewindSessionView = async ({
	createFork,
	navigate,
}: Readonly<{
	createFork: () => Promise<SessionRewindAction>;
	navigate: (sessionId: SessionId) => Promise<void>;
}>): Promise<void> => {
	const action = await createFork();
	await navigate(action.sessionId);
	await action.complete();
};
