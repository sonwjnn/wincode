import { expect, test } from "bun:test";
import type {
	CreateSessionUsageEntryInput,
	SessionUsageEntry,
	SessionWriteOutcome,
} from "@/modules/sessions/storage/session-store";
import {
	createSessionUsageLedger,
	type SessionUsageLedger,
} from "@/modules/sessions/usage/session-usage-ledger";
import {
	providerModelSelectionFixture,
	sessionId,
	sessionUsageEntryId,
} from "../support/identifiers";

const session = sessionId("usage-ledger");
const model = providerModelSelectionFixture("openai/gpt-5.6");
const initialEntry: SessionUsageEntry = {
	createdAt: new Date("2026-10-01T00:00:00.000Z"),
	id: sessionUsageEntryId("usage-initial"),
	kind: "cache-warm",
	model,
	sessionId: session,
	usage: { inputTokens: 100, outputTokens: 1 },
};
const summaryEntryInput: Omit<CreateSessionUsageEntryInput, "sessionId"> = {
	id: sessionUsageEntryId("usage-summary"),
	kind: "compaction-summary",
	model,
	usage: { inputTokens: 20, outputTokens: 4 },
};

test("records durable usage before publishing it to Session observers", async () => {
	let ledger!: SessionUsageLedger;
	let storeCommitted = false;
	let observerSawCommit = false;
	let notifications = 0;
	ledger = createSessionUsageLedger({
		initialEntries: [initialEntry],
		sessionId: session,
		store: {
			createSessionUsageEntry: async (input) => {
				expect(ledger.getEntries()).toEqual([initialEntry]);
				storeCommitted = true;
				return {
					entry: {
						...input,
						createdAt: input.createdAt ?? new Date("2026-10-02T00:00:00.000Z"),
					},
					writeOutcome: {
						entryHash: "0".repeat(64),
						kind: "committed",
						operationId: `usage-${input.id}`,
						projection: "ready",
						sequence: 1,
					} satisfies SessionWriteOutcome,
				};
			},
		},
	});
	const unsubscribe = ledger.subscribe(() => {
		notifications += 1;
		observerSawCommit ||= storeCommitted;
	});

	try {
		const entry = await ledger.record(summaryEntryInput);

		expect(entry).toMatchObject({
			...summaryEntryInput,
			sessionId: session,
		});
		expect(ledger.getEntries()).toEqual([initialEntry, entry]);
		expect(notifications).toBe(1);
		expect(observerSawCommit).toBe(true);
	} finally {
		unsubscribe();
		ledger.dispose();
	}
});

test("does not publish a usage entry when durable storage rejects it", async () => {
	let notifications = 0;
	const ledger = createSessionUsageLedger({
		initialEntries: [initialEntry],
		sessionId: session,
		store: {
			createSessionUsageEntry: async () => {
				throw new Error("usage write failed");
			},
		},
	});
	const unsubscribe = ledger.subscribe(() => {
		notifications += 1;
	});

	try {
		await expect(ledger.record(summaryEntryInput)).rejects.toThrow(
			"usage write failed"
		);
		expect(ledger.getEntries()).toEqual([initialEntry]);
		expect(notifications).toBe(0);
	} finally {
		unsubscribe();
		ledger.dispose();
	}
});
