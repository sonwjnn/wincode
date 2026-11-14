import type {
	CreateSessionUsageEntryInput,
	SessionUsageEntry,
} from "@/modules/sessions/storage/session-catalog";
import type { SessionId } from "@/shared/identifiers";
import { SessionWriteOutcomeError } from "../session-write-outcome";
import type { SessionCatalog } from "../storage/session-catalog";
import { requireSessionWriteReady } from "../storage/session-jsonl-store";

export type SessionUsageLedger = Readonly<{
	dispose: () => void;
	getEntries: () => readonly SessionUsageEntry[];
	record: (
		input: Omit<CreateSessionUsageEntryInput, "sessionId">
	) => Promise<SessionUsageEntry>;
	subscribe: (listener: () => void) => () => void;
}>;

export type SessionUsageLedgerOptions = Readonly<{
	initialEntries: readonly SessionUsageEntry[];
	sessionId: SessionId;
	store: Pick<SessionCatalog, "createSessionUsageEntry">;
}>;

/** One Session-owned durable ledger shared by cache warming and compaction. */
export const createSessionUsageLedger = ({
	initialEntries,
	sessionId,
	store,
}: SessionUsageLedgerOptions): SessionUsageLedger => {
	const entries = new Map(initialEntries.map((entry) => [entry.id, entry]));
	const listeners = new Set<() => void>();
	const notifyListeners = (): void => {
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch {
				// Usage observers cannot change durable accounting.
			}
		}
	};

	return {
		dispose: () => listeners.clear(),
		getEntries: () => [...entries.values()],
		record: async (input) => {
			const result = await store.createSessionUsageEntry({
				...input,
				sessionId,
			});
			const receipt = requireSessionWriteReady(result.writeOutcome);
			if (result.entry === undefined) {
				throw new SessionWriteOutcomeError(
					{ ...receipt, projection: "blocked" },
					new Error("Committed usage entry is missing from its projection.")
				);
			}
			entries.set(result.entry.id, result.entry);
			notifyListeners();
			return result.entry;
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
};
