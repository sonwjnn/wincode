import { describe, expect, test } from "bun:test";
import { prepareSendChatRequestBody } from "./chat-request";

describe("prepareSendChatRequestBody", () => {
	test("keeps undefined variant on latest metadata turn", () => {
		const body = prepareSendChatRequestBody(
			"session-1",
			[
				{
					id: "1",
					role: "user",
					parts: [],
					metadata: {
						mode: "build",
						model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
						variant: "high",
					},
				},
				{
					id: "2",
					role: "user",
					parts: [],
					metadata: {
						mode: "build",
						model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
						variant: undefined,
					},
				},
			],
			{
				mode: "build",
				model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
				variant: "high",
			}
		);

		expect(body.variant).toBe("high");
	});

	test("rejects malformed model metadata", () => {
		expect(() =>
			prepareSendChatRequestBody("session-1", [
				{
					id: "1",
					role: "user",
					parts: [],
					metadata: {
						mode: "build",
						model: JSON.parse('{"modelId":"gpt-5.4-mini"}'),
					},
				},
			])
		).toThrow("No chat mode or model to send");
	});

	test("rejects unsupported model pair metadata", () => {
		expect(() =>
			prepareSendChatRequestBody("session-1", [
				{
					id: "1",
					role: "user",
					parts: [],
					metadata: {
						mode: "build",
						model: JSON.parse(
							'{"modelId":"gpt-5.4-mini","providerId":"anthropic"}'
						),
					},
				},
			])
		).toThrow("No chat mode or model to send");
	});
});
