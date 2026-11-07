import { expect, test } from "bun:test";
import { createAgentRuntime, type SessionRecord } from "@wincode/agent-core";
import { createProviderCollection, ProviderError } from "@wincode/ai";
import { buildAgent } from "@/modules/agents/built-ins";
import { CommittedAssistantError } from "@/modules/sessions/committed-assistant-error";
import {
	buildAgentTurn,
	runAgentTurnToText,
	type SessionViewState,
} from "@/modules/sessions/hooks/runtime-turn";
import { getSessionRecordValidationError } from "@/modules/sessions/storage/session-record";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionMessageId,
} from "../support/identifiers";

for (const { scenario, expectedRequests, expectedCountdowns, terminalKind } of [
	{
		scenario: "recover",
		expectedRequests: 2,
		expectedCountdowns: 1,
		terminalKind: "completed",
	},
	{
		scenario: "exhaust",
		expectedRequests: 3,
		expectedCountdowns: 2,
		terminalKind: "failed",
	},
	{
		scenario: "cancel",
		expectedRequests: 1,
		expectedCountdowns: 1,
		terminalKind: "cancelled",
	},
	{
		scenario: "authentication",
		expectedRequests: 1,
		expectedCountdowns: 0,
		terminalKind: "failed",
	},
	{
		scenario: "usage",
		expectedRequests: 3,
		expectedCountdowns: 2,
		terminalKind: "failed",
	},
] as const) {
	test(`model retry ${scenario} publishes transient countdowns and commits only one terminal checkpoint`, async () => {
		const controller = new AbortController();
		const providers = createProviderCollection();
		let requests = 0;
		providers.register({
			id: "retry-provider",
			models: [
				{
					modelId: "retry-model",
					providerId: "retry-provider",
					protocolId: "fake",
					capabilities: ["text"],
				},
			],
			resolveAuthorization: () => ({ authorization: { kind: "fake" } }),
			async *streamChat() {
				requests += 1;
				if (scenario === "usage") {
					yield {
						type: "usage",
						usage: { inputTokens: 10, outputTokens: 1 },
					};
					throw new ProviderError("transport", "private provider diagnostics");
				}
				if (scenario !== "recover" || requests === 1) {
					throw new ProviderError(
						scenario === "authentication" ? "authentication" : "transport",
						"private provider diagnostics"
					);
				}
				yield { type: "text-delta", delta: "Recovered response" };
				yield { completion: { kind: "completed" }, type: "finish" };
			},
		});
		const turn = buildAgentTurn({
			agent: agentId("build"),
			model: { modelId: modelId("retry-model"), providerId: "retry-provider" },
			modelMessages: [
				{
					id: sessionMessageId("retry-user"),
					parts: [{ type: "text", text: "hello" }],
					role: "user",
				},
			],
			resolvedAgent: buildAgent,
			turnId: agentTurnId(`retry-${scenario}`),
		});
		const views: SessionViewState[] = [];
		const records: SessionRecord[] = [];
		try {
			const running = runAgentTurnToText({
				runtime: createAgentRuntime({ providerCollection: providers }),
				turn,
				signal: controller.signal,
				getAssistantMessageId: () => sessionMessageId("retry-assistant"),
				modelRetry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 60_000 },
				onViewState: (view) => {
					views.push(view);
					if (scenario === "cancel" && view.retry !== undefined) {
						controller.abort();
					}
				},
				onCheckpoint: (record) => {
					records.push(record);
				},
			});
			if (scenario === "recover") {
				expect(await running).toBe("Recovered response");
			} else {
				await expect(running).rejects.toBeInstanceOf(Error);
				if (terminalKind === "failed") {
					await expect(running).rejects.toBeInstanceOf(CommittedAssistantError);
					await expect(running).rejects.toMatchObject({
						assistantMessageId: sessionMessageId("retry-assistant"),
					});
				}
			}
			expect(requests).toBe(expectedRequests);
			expect(views.filter(({ retry }) => retry !== undefined)).toHaveLength(
				expectedCountdowns
			);
			expect(views.at(-1)?.retry).toBeUndefined();
			expect(records).toHaveLength(1);
			expect(records[0]?.messages[0]?.id).toBe(
				sessionMessageId("retry-assistant")
			);
			expect(records[0]?.outcome).toMatchObject({
				kind: "assistant",
				terminal: { kind: terminalKind },
			});
			expect(JSON.stringify(records)).not.toContain(
				"private provider diagnostics"
			);
			expect(JSON.stringify(records)).not.toContain("retryAt");
			if (scenario === "usage") {
				expect(getSessionRecordValidationError(records[0])).toBeNull();
				expect(records[0]?.messages[0]?.metadata?.usage).toEqual({
					inputTokens: 30,
					outputTokens: 3,
					totalTokens: 33,
				});
				expect(records[0]?.outcome).toMatchObject({
					terminal: {
						kind: "failed",
						modelStepAttempts: [
							{
								attempt: 1,
								retryDecision: "scheduled",
								usage: { inputTokens: 10 },
							},
							{
								attempt: 2,
								retryDecision: "scheduled",
								usage: { inputTokens: 10 },
							},
							{
								attempt: 3,
								retryDecision: "stopped",
								usage: { inputTokens: 10 },
							},
						],
						usage: { inputTokens: 30, outputTokens: 3, totalTokens: 33 },
					},
				});
			}
		} finally {
			await providers.close();
		}
	});
}
