import { expect, test } from "bun:test";
import {
	projectAgentEvent,
	projectSteering,
	submissionFromWaiting,
} from "../modules/application/rpc/projection";
import { readSubmission } from "../modules/application/rpc/validation";
import { MAX_ATTACHMENT_BYTES } from "../modules/sessions/storage/attachment-store";

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
