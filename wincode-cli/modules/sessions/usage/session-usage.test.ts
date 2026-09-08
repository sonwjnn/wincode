import { expect, test } from "bun:test";
import type { ChatModelSelection } from "@wincode/ai/models";
import type { SessionMessage } from "@/modules/sessions/message";
import { summarizeSessionUsage } from "./session-usage";

const model: ChatModelSelection = {
	modelId: "gpt-5.4-mini",
	providerId: "openai",
};
const table = {
	"openai/gpt-5.4-mini": { contextLimit: 1000 },
};

const assistant = (
	id: string,
	usage?: { inputTokens: number; outputTokens: number }
): SessionMessage => ({
	id,
	metadata: usage ? { model, usage } : { model },
	parts: [{ text: id, type: "text" }],
	role: "assistant",
});

test("retains the last provider usage until the next completed assistant", () => {
	const measured = assistant("assistant-1", {
		inputTokens: 90,
		outputTokens: 10,
	});
	const beforeNextUsage = summarizeSessionUsage(
		[measured, { id: "user-2", parts: [], role: "user" }],
		model,
		table
	);

	expect(beforeNextUsage).toEqual({
		contextLimit: 1000,
		contextPercent: 10,
		contextTokens: 100,
	});

	const afterNextUsage = summarizeSessionUsage(
		[
			measured,
			{ id: "user-2", parts: [], role: "user" },
			assistant("assistant-2", { inputTokens: 40, outputTokens: 5 }),
		],
		model,
		table
	);

	expect(afterNextUsage?.contextTokens).toBe(45);
});

test("hides the usage bar before any provider usage exists", () => {
	expect(
		summarizeSessionUsage(
			[{ id: "user-1", parts: [], role: "user" }],
			model,
			table
		)
	).toBeNull();
});
