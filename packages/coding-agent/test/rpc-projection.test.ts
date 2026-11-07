import { expect, test } from "bun:test";
import {
	projectAgentEvent,
	projectSessionEvent,
	projectSteering,
	submissionFromWaiting,
} from "../modules/application/rpc/projection";
import { readSubmission } from "../modules/application/rpc/validation";
import { MAX_ATTACHMENT_BYTES } from "../modules/sessions/attachment-reference";

test("RPC retry events expose bounded timing and a safe failure without provider diagnostics", () => {
	const projected = projectAgentEvent({
		attempt: 1,
		failure: {
			code: "network",
			details: { providerId: "openai", retryAfterMs: 500 },
			message: "The model connection failed.",
			retry: "after-delay",
			source: "model",
			version: 1,
		},
		maxAttempts: 3,
		partialOutput: { text: "discarded fragment" },
		retryAt: 10_500,
		sequence: 2,
		stepId: "step-1",
		usage: { inputTokens: 10, outputTokens: 1 },
		turnId: "turn-1",
		type: "model-step-retry-scheduled",
	});

	expect(projected).toMatchObject({
		attempt: 1,
		failure: {
			code: "network",
			details: { providerId: "openai", retryAfterMs: 500 },
			message: "The model connection failed.",
			retry: "after-delay",
			source: "model",
			version: 1,
		},
		maxAttempts: 3,
		partialOutput: { text: "discarded fragment" },
		retryAt: 10_500,
		sequence: 2,
		stepId: "step-1",
		turnId: "turn-1",
		type: "model-step-retry-scheduled",
		usage: { inputTokens: 10, outputTokens: 1 },
	});
	expect(JSON.stringify(projected)).not.toContain(
		"private provider diagnostics"
	);
});

test("Session event projection keeps compaction retry observations safe and bounded", () => {
	const projected = projectSessionEvent({
		attempt: 1,
		compactionId: "compaction-1",
		failure: {
			code: "network",
			details: { providerId: "openai", retryAfterMs: 500 },
			message: "The model connection failed.",
			retry: "after-delay",
			source: "model",
			version: 1,
		},
		maxRetries: 3,
		modelId: "gpt-5.6-luna",
		privateDiagnostic: "must not cross the RPC boundary",
		providerId: "openai",
		retryAt: 10_500,
		sessionId: "session-1",
		stepId: "step-1",
		type: "compaction-summary-retry-scheduled",
	});

	expect(projected).toMatchObject({
		attempt: 1,
		compactionId: "compaction-1",
		failure: { code: "network", message: "The model connection failed." },
		maxRetries: 3,
		modelId: "gpt-5.6-luna",
		providerId: "openai",
		retryAt: 10_500,
		sessionId: "session-1",
		stepId: "step-1",
		type: "compaction-summary-retry-scheduled",
	});
	expect(projected).not.toHaveProperty("privateDiagnostic");
	expect(JSON.stringify(projected)).not.toContain(
		"private provider diagnostics"
	);
});

test("RPC retry terminal events preserve the retry result and safe failure", () => {
	const projected = projectAgentEvent({
		attempt: 1,
		failure: {
			code: "network",
			message: "The model connection failed.",
			retry: "after-delay",
			source: "model",
			version: 1,
		},
		maxAttempts: 1,
		outcome: "exhausted",
		sequence: 3,
		stepId: "step-2",
		turnId: "turn-1",
		type: "model-step-retry-ended",
	});

	expect(projected).toMatchObject({
		attempt: 1,
		failure: { code: "network" },
		maxAttempts: 1,
		outcome: "exhausted",
		type: "model-step-retry-ended",
	});
});

test("RPC projects non-retryable account-limit failures without throwing", () => {
	const projected = projectAgentEvent({
		failure: {
			code: "account-limit",
			message: "The model provider account has reached its usage limit.",
			retry: "never",
			source: "model",
			version: 1,
		},
		finishedAt: 10_000,
		sequence: 4,
		turnId: "turn-1",
		type: "agent-turn-failed",
	});

	expect(projected).toMatchObject({
		failure: {
			code: "account-limit",
			message: "The model provider account has reached its usage limit.",
			retry: "never",
		},
		type: "agent-turn-failed",
	});
});

test("RPC failed Agent Turn projection preserves reported usage and safe failure text", () => {
	const projected = projectAgentEvent({
		modelStepAttempts: [
			{
				attempt: 1,
				failure: {
					code: "network",
					message: "The model connection failed.",
					retry: "after-delay",
					source: "model",
					version: 1,
				},
				maxRetries: 1,
				partialOutput: { text: "discarded fragment" },
				retryDecision: "scheduled",
				stepId: "step-1",
				usage: { inputTokens: 10, outputTokens: 1 },
			},
		],
		failure: {
			code: "network",
			message: "The model connection failed.",
			retry: "after-delay",
			source: "model",
			version: 1,
		},
		finishedAt: 10_000,
		sequence: 3,
		turnId: "turn-1",
		type: "agent-turn-failed",
		usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
	});

	expect(projected).toMatchObject({
		failure: {
			code: "network",
			message: "The model connection failed.",
			retry: "after-delay",
			source: "model",
			version: 1,
		},
		finishedAt: 10_000,
		modelStepAttempts: [
			{
				attempt: 1,
				failure: {
					code: "network",
					message: "The model connection failed.",
					retry: "after-delay",
					source: "model",
					version: 1,
				},
				maxRetries: 1,
				partialOutput: { text: "discarded fragment" },
				retryDecision: "scheduled",
				stepId: "step-1",
				usage: { inputTokens: 10, outputTokens: 1 },
			},
		],
		sequence: 3,
		turnId: "turn-1",
		type: "agent-turn-failed",
		usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
	});
	expect(JSON.stringify(projected)).not.toContain(
		"private provider diagnostics"
	);
});

test("RPC preserves the safe explanation when a Retry-After exceeds the retry limit", () => {
	const projected = projectAgentEvent({
		failure: {
			code: "retry-delay-exceeds-limit",
			message:
				"The provider requested a retry delay beyond the configured limit; automatic retry was not attempted.",
			retry: "never",
			source: "runtime",
			version: 1,
		},
		finishedAt: 10_000,
		sequence: 3,
		turnId: "turn-1",
		type: "agent-turn-failed",
	});

	expect(projected).toMatchObject({
		failure: {
			code: "retry-delay-exceeds-limit",
			message:
				"The provider requested a retry delay beyond the configured limit; automatic retry was not attempted.",
		},
		type: "agent-turn-failed",
	});
});

test("public Agent Turn projection preserves empty delta events", () => {
	for (const type of ["text-delta", "reasoning-delta"] as const) {
		expect(
			projectAgentEvent({ delta: "", sequence: 0, turnId: "turn-1", type })
		).toEqual({ delta: "", sequence: 0, turnId: "turn-1", type });
	}
});

test("RPC accepted Submission projection keeps transcript file bytes private", () => {
	const projected = projectSteering({
		id: "steering-1",
		input: {
			agent: "build",
			composition: {
				files: [
					{
						filename: "secret.png",
						mediaType: "image/png",
						type: "file",
						url: "data:image/png;base64,AQID",
					},
				],
				text: "Review this",
			},
			messageId: "message-1",
			model: { modelId: "gpt-5.6-luna", providerId: "openai" },
			submissionId: "submission-1",
			userText: "Review this",
		},
		message: {
			id: "message-1",
			parts: [
				{
					filename: "secret.png",
					mediaType: "image/png",
					type: "file",
					url: "data:image/png;base64,AQID",
				},
				{ text: "Review this", type: "text" },
			],
			role: "user",
		},
		recordId: "record-1",
		reason: "Resolve the missing image",
		status: "failed",
	} as unknown as Parameters<typeof projectSteering>[0]);

	expect(projected).toMatchObject({
		messageId: "message-1",
		recordId: "record-1",
		reason: "Resolve the missing image",
		status: "failed",
		submissionId: "submission-1",
		composition: {
			files: [
				{
					content: { data: "AQID", encoding: "base64" },
					filename: "secret.png",
					mediaType: "image/png",
				},
			],
			text: "Review this",
		},
	});
	expect(JSON.stringify(projected.message)).not.toContain("AQID");
});

test("RPC recall preserves inline files in the submit wire shape", async () => {
	const recalled = submissionFromWaiting({
		id: "queued-1",
		input: {
			agent: "build",
			composition: {
				fileTokens: [{ start: 0, token: "[Image 1]" }],
				files: [
					{
						filename: "diagram.png",
						mediaType: "image/png",
						type: "file",
						url: "data:image/png;base64,AQID",
					},
				],
				text: "[Image 1] inspect this",
			},
			model: { modelId: "gpt-5.6-luna", providerId: "openai" },
		},
		messageId: "message-1",
		submissionId: "submission-1",
	} as unknown as Parameters<typeof submissionFromWaiting>[0]);

	expect(recalled.composition).toMatchObject({
		fileTokens: [{ start: 0, token: "[Image 1]" }],
		files: [
			{
				content: { data: "AQID", encoding: "base64" },
				filename: "diagram.png",
				mediaType: "image/png",
			},
		],
		text: "[Image 1] inspect this",
	});
	const submission = await readSubmission(
		{
			submission: {
				composition: recalled.composition,
				text: recalled.text,
			},
		},
		"submission"
	);
	expect(submission.files[0]).toMatchObject({
		filename: "diagram.png",
		mediaType: "image/png",
		type: "file",
		url: "data:image/png;base64,AQID",
	});
});

test("RPC recall keeps pasted-text offsets private while retaining its existing input shape", async () => {
	const token = "[Pasted ~3 lines]";
	const text = `Inspect ${token}`;
	const pastedText = "first\nsecond\nthird";
	const recalled = submissionFromWaiting({
		id: "queued-paste",
		input: {
			agent: "build",
			composition: {
				files: [],
				pastedText: [{ start: 8, text: pastedText, token }],
				text,
			},
			model: { modelId: "gpt-5.6-luna", providerId: "openai" },
		},
		messageId: "message-paste",
		submissionId: "submission-paste",
	} as unknown as Parameters<typeof submissionFromWaiting>[0]);

	expect(recalled.composition).toMatchObject({
		pastedText: [{ text: pastedText, token }],
		text,
	});
	expect(recalled.composition).not.toHaveProperty("pastedText.0.start");
	const submitted = await readSubmission(
		{ submission: { composition: recalled.composition, text } },
		"submission"
	);
	expect(submitted.composition.pastedText).toEqual([
		{ start: 8, text: pastedText, token },
	]);
});

test("RPC recall omits local URLs and oversized inline file content", () => {
	const oversizedData = "A".repeat(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4);
	const recalled = submissionFromWaiting({
		id: "queued-1",
		input: {
			agent: "build",
			composition: {
				files: [
					{
						filename: "local.png",
						mediaType: "image/png",
						type: "file",
						url: "file:///private/local.png",
					},
					{
						filename: "large.png",
						mediaType: "image/png",
						type: "file",
						url: `data:image/png;base64,${oversizedData}`,
					},
				],
				text: "inspect these",
			},
			model: { modelId: "gpt-5.6-luna", providerId: "openai" },
		},
		messageId: "message-1",
		submissionId: "submission-1",
	} as unknown as Parameters<typeof submissionFromWaiting>[0]);

	expect(recalled.composition).toMatchObject({
		files: [
			{ filename: "local.png", mediaType: "image/png", type: "file" },
			{ filename: "large.png", mediaType: "image/png", type: "file" },
		],
	});
	expect(JSON.stringify(recalled)).not.toContain("file:///private/local.png");
	expect(JSON.stringify(recalled)).not.toContain("data:image/png;base64,");
});
