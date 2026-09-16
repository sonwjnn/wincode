import { expect, mock, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import type { ChatModelSelection } from "@wincode/ai/models";
import type { CompactSessionResult } from "@/modules/sessions/compaction/compaction";
import {
	SessionCompactionError,
	type SessionCompactionModule,
} from "@/modules/sessions/compaction/compaction";
import type { ResolvedCompactionSettings } from "@/modules/sessions/compaction/config";
import { prepareCompactionBeforeSubmit } from "@/modules/sessions/hooks/use-chat";
import type { SessionMessage } from "@/modules/sessions/message";
import { modelId, sessionMessageId } from "../support/identifiers";

const model: ChatModelSelection = {
	modelId: modelId("gpt-5.6-luna"),
	providerId: "openai",
};

const settings = fromPartial<ResolvedCompactionSettings>({
	autoAvailable: true,
});

const message = (id: string): SessionMessage =>
	fromPartial<SessionMessage>({
		id: sessionMessageId(id),
		parts: [{ text: id, type: "text" }],
		role: "user",
	});

const createSubmission = ({
	needs,
	runCompaction,
	settleCompaction,
}: {
	needs: boolean[];
	runCompaction: () => Promise<CompactSessionResult>;
	settleCompaction: () => Promise<Error | null>;
}) =>
	prepareCompactionBeforeSubmit({
		compactionModule: fromPartial<SessionCompactionModule>({
			needsCompaction: mock(() => needs.shift() ?? false),
		}),
		getActiveMessages: () => [message("u1")],
		model,
		runCompaction: mock(runCompaction),
		settings,
		settleCompaction,
	});

test("keeps a submission's threshold when another compaction owns the swap", async () => {
	const compactionCalls: string[] = [];
	const settled = mock(async () => null);
	const result = await createSubmission({
		// The joined compaction left the context under the threshold.
		needs: [true, false],
		runCompaction: async () => {
			compactionCalls.push("threshold");
			throw new SessionCompactionError(
				"in-flight",
				"A manual compaction is already in flight for this session."
			);
		},
		settleCompaction: settled,
	});

	expect(result).toEqual({ ok: true });
	expect(settled).toHaveBeenCalledTimes(1);
	expect(compactionCalls).toEqual(["threshold"]);
});

test("compacts on its own when the joined compaction left the threshold unmet", async () => {
	const compactionCalls: string[] = [];
	const result = await createSubmission({
		needs: [true, true],
		runCompaction: async () => {
			compactionCalls.push("threshold");
			if (compactionCalls.length === 1) {
				throw new SessionCompactionError(
					"in-flight",
					"An overflow compaction is already in flight for this session."
				);
			}
			return fromPartial<CompactSessionResult>({
				activeMessages: [],
				entry: {},
			});
		},
		settleCompaction: async () => null,
	});

	expect(result).toEqual({ ok: true });
	expect(compactionCalls).toEqual(["threshold", "threshold"]);
});

test("reports a joined compaction's failure instead of starting a second one", async () => {
	const runCompaction = mock(async () => {
		throw new SessionCompactionError(
			"in-flight",
			"A manual compaction is already in flight for this session."
		);
	});
	const result = await createSubmission({
		needs: [true],
		runCompaction,
		settleCompaction: async () => new Error("summary provider failed"),
	});

	expect(result).toEqual({ ok: false, reason: "summary provider failed" });
	expect(runCompaction).toHaveBeenCalledTimes(1);
});
