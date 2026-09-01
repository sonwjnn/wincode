import { expect, test } from "bun:test";
import type { CodingAgentUIMessage } from "@wincode/ai";
import type { ModelPricingTable } from "@/modules/model-pricing";
import type { ConversationCompaction } from "../compaction";
import { summarizeSessionUsage } from "./session-usage";

const model = { modelId: "gpt-5.4-mini", providerId: "openai" } as const;
const table: ModelPricingTable = {
	"openai/gpt-5.4-mini": {
		contextLimit: 400_000,
		cost: { input: 1, output: 2 },
	},
};

const compaction: ConversationCompaction = {
	completedAt: new Date("2026-08-30T00:00:00.000Z"),
	createdAt: new Date("2026-08-30T00:00:00.000Z"),
	firstKeptUiMessageId: "u2",
	id: "c1",
	sequence: 1,
	sessionId: "session-1",
	summarizationModel: model,
	summarizationUsage: { inputTokens: 1000, outputTokens: 100 },
	summary: {
		coveredMessageIds: ["u1", "a1"],
		formatVersion: 1,
		text: "summary",
	},
	throughMessageUiId: "a1",
	tokensAfter: 12_000,
	tokensBefore: 100_000,
	trigger: "manual",
};

const message = (
	id: string,
	role: CodingAgentUIMessage["role"],
	metadata?: CodingAgentUIMessage["metadata"]
): CodingAgentUIMessage =>
	({
		id,
		metadata,
		parts: [{ text: id, type: "text" }],
		role,
	}) as CodingAgentUIMessage;

test("uses the durable post-compaction estimate and counts summary usage", () => {
	const summary = summarizeSessionUsage(
		[message("u1", "user"), message("a1", "assistant")],
		model,
		table,
		[compaction]
	);

	expect(summary).toMatchObject({
		contextLimit: 400_000,
		contextTokens: 12_000,
		contextPercent: 3,
	});
	expect(summary?.costUsd).toBeCloseTo(0.0012, 10);
});

test("uses a newer provider usage record after compaction", () => {
	const summary = summarizeSessionUsage(
		[
			message("u1", "user"),
			message("a1", "assistant"),
			message("u2", "user"),
			message("a2", "assistant", {
				model,
				usage: { inputTokens: 20_000, outputTokens: 500 },
			}),
		],
		model,
		table,
		[compaction]
	);

	expect(summary?.contextTokens).toBe(20_500);
});
