import type { SessionId } from "@/shared/identifiers";

export type SessionRewindAction = Readonly<{
	complete: () => Promise<void>;
	sessionId: SessionId;
}>;

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
