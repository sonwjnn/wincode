import { randomUUID } from "node:crypto";
import { and, eq, gt, lte } from "drizzle-orm";
import type { SessionId, WorkspaceId } from "@/shared/identifiers";
import type { SessionDatabase } from "./client";
import { session, sessionLease } from "./schema";

export const SESSION_LEASE_TTL_MS = 30_000;
export const SESSION_LEASE_RENEWAL_INTERVAL_MS = 10_000;

export type SessionLeaseOptions = Readonly<{
	now?: () => number;
}>;

export type SessionLease = Readonly<{
	renew: () => boolean;
	release: () => void;
}>;

export type SessionLeaseStore = Readonly<{
	acquire: (
		sessionId: SessionId,
		options?: SessionLeaseOptions
	) => Promise<SessionLease>;
}>;

export class SessionInUseError extends Error {
	readonly code = "session_in_use" as const;

	constructor() {
		super("Session is already in use by another Session Host.");
		this.name = "SessionInUseError";
	}
}
export class SessionLeaseLostError extends Error {
	readonly code = "session_lease_lost" as const;

	constructor() {
		super("Session Lease was lost while the Host was opening.");
		this.name = "SessionLeaseLostError";
	}
}

export type SessionLeaseStoreOptions = Readonly<{
	workspaceId: WorkspaceId;
}>;

const toLeaseDate = (milliseconds: number): Date => new Date(milliseconds);

export const createSessionLeaseStore = (
	db: SessionDatabase,
	options: SessionLeaseStoreOptions
): SessionLeaseStore => ({
	acquire: async (sessionId, leaseOptions = {}) => {
		const existingSession = db
			.select({ id: session.id })
			.from(session)
			.where(
				and(
					eq(session.id, sessionId),
					eq(session.workspaceId, options.workspaceId)
				)
			)
			.get();
		if (!existingSession) {
			throw new Error("Session not found");
		}

		const ownerToken = randomUUID();
		const now = leaseOptions.now?.() ?? Date.now();
		const renewedAt = toLeaseDate(now);
		const expiresAt = toLeaseDate(now + SESSION_LEASE_TTL_MS);
		db.insert(sessionLease)
			.values({
				expiresAt,
				ownerToken,
				renewedAt,
				sessionId,
			})
			.onConflictDoUpdate({
				set: { expiresAt, ownerToken, renewedAt },
				target: sessionLease.sessionId,
				where: lte(sessionLease.expiresAt, renewedAt),
			})
			.run();

		const claimed = db
			.select({ ownerToken: sessionLease.ownerToken })
			.from(sessionLease)
			.where(eq(sessionLease.sessionId, sessionId))
			.get();
		if (claimed?.ownerToken !== ownerToken) {
			throw new SessionInUseError();
		}

		let released = false;
		return {
			renew: (): boolean => {
				if (released) {
					return false;
				}
				const renewedAt = toLeaseDate(leaseOptions.now?.() ?? Date.now());
				const expiresAt = toLeaseDate(
					renewedAt.getTime() + SESSION_LEASE_TTL_MS
				);
				try {
					db.update(sessionLease)
						.set({ expiresAt, renewedAt })
						.where(
							and(
								eq(sessionLease.sessionId, sessionId),
								eq(sessionLease.ownerToken, ownerToken),
								gt(sessionLease.expiresAt, renewedAt)
							)
						)
						.run();
					const current = db
						.select({
							expiresAt: sessionLease.expiresAt,
							ownerToken: sessionLease.ownerToken,
						})
						.from(sessionLease)
						.where(
							and(
								eq(sessionLease.sessionId, sessionId),
								eq(sessionLease.ownerToken, ownerToken)
							)
						)
						.get();
					return (
						current?.ownerToken === ownerToken &&
						current.expiresAt.getTime() === expiresAt.getTime()
					);
				} catch {
					return false;
				}
			},
			release: (): void => {
				if (released) {
					return;
				}
				released = true;
				try {
					db.delete(sessionLease)
						.where(
							and(
								eq(sessionLease.sessionId, sessionId),
								eq(sessionLease.ownerToken, ownerToken)
							)
						)
						.run();
				} catch {
					// Expiry is the fallback when release is contended.
				}
			},
		};
	},
});
