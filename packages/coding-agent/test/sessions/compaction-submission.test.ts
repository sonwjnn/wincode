import { expect, mock, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import {
	type ProviderModelSelection,
	parseProviderModelSelection,
} from "@/modules/providers/provider-model-selection";
import { prepareCompactionBeforeSubmit } from "@/modules/sessions/agent-session/submission";
import type {
	CompactSessionResult,
	SessionCompactionModule,
} from "@/modules/sessions/compaction";
import {
	type ResolvedCompactionSettings,
	resolveCompactionSettings,
} from "@/modules/sessions/compaction/config";
import { SessionCompactionError } from "@/modules/sessions/compaction/error";
import type { SessionMessage } from "@/modules/sessions/message";
import { modelId, sessionMessageId } from "../support/identifiers";

const model: ProviderModelSelection = {
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
		compaction: fromPartial<SessionCompactionModule>({
			needsCompaction: mock(() => needs.shift() ?? false),
		}),
		getActiveMessages: () => [message("u1")],
		model,
		runCompaction: mock(runCompaction),
		settings,
		settleCompaction,
	});

test("skips threshold compaction when the model context limit is unknown", async () => {
	const runCompaction = mock(async () =>
		fromPartial<CompactSessionResult>({ activeMessages: [], entry: {} })
	);
	const result = await prepareCompactionBeforeSubmit({
		compaction: fromPartial<SessionCompactionModule>({
			needsCompaction: mock(() => true),
		}),
		getActiveMessages: () => [message("u1")],
		model,
		runCompaction,
		settings: fromPartial<ResolvedCompactionSettings>({
			autoAvailable: false,
			thresholdTokens: null,
		}),
		settleCompaction: async () => null,
	});

	expect(result).toEqual({ ok: true });
	expect(runCompaction).not.toHaveBeenCalled();
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

test("rechecks settled Context using the waiting model's exact policy", async () => {
	const waitingModel = parseProviderModelSelection(
		"anthropic/claude-3-7-sonnet"
	);
	if (waitingModel === null) {
		throw new Error("The waiting Provider Model fixture was invalid.");
	}
	const waitingSettings = resolveCompactionSettings({
		contextLimit: 100_000,
		model: waitingModel,
		snapshot: {
			diagnostics: [],
			document: {
				compaction: {
					modelOverrides: {
						"anthropic/claude-3-7-sonnet": { reserveTokens: 24_000 },
					},
				},
			},
			sourceFor: () => undefined,
			sources: [],
		},
	});
	let activeMessages = [message("before-owner-settles")];
	const observations: Array<{
		messageIds: string[];
		model: ProviderModelSelection | undefined;
		thresholdTokens: number | null;
	}> = [];
	const needsCompaction = mock(
		(
			messages: readonly SessionMessage[],
			currentSettings: Pick<
				ResolvedCompactionSettings,
				"enabled" | "thresholdTokens"
			>,
			currentModel?: ProviderModelSelection
		) => {
			observations.push({
				messageIds: messages.map(({ id }) => id),
				model: currentModel,
				thresholdTokens: currentSettings.thresholdTokens,
			});
			return observations.length === 1;
		}
	);
	const result = await prepareCompactionBeforeSubmit({
		compaction: fromPartial<SessionCompactionModule>({ needsCompaction }),
		getActiveMessages: () => activeMessages,
		model: waitingModel,
		runCompaction: async () => {
			throw new SessionCompactionError(
				"in-flight",
				"A compaction for another Provider Model is already in flight."
			);
		},
		settings: waitingSettings,
		settleCompaction: async () => {
			activeMessages = [message("after-owner-settles")];
			return null;
		},
	});

	expect(result).toEqual({ ok: true });
	expect(observations).toEqual([
		{
			messageIds: [sessionMessageId("before-owner-settles")],
			model: waitingModel,
			thresholdTokens: 76_000,
		},
		{
			messageIds: [sessionMessageId("after-owner-settles")],
			model: waitingModel,
			thresholdTokens: 76_000,
		},
	]);
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
