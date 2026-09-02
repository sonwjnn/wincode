import { describe, expect, mock, test } from "bun:test";
import { getToolResourceLimits } from "@wincode/ai";
import { createWorkspaceSandbox } from "@wincode/ai/workspace";
import {
	createPermissionService,
	createToolPermission,
} from "@/modules/permissions";
import { createToolGate } from "@/modules/tool-gate/tool-gate";
import type { ConversationSendInput } from "./conversation-operation";
import { createConversationOperation } from "./conversation-operation";

const request: ConversationSendInput = {
	agent: "build",
	conversationModel: { modelId: "gpt-5.4-mini", providerId: "openai" },
	files: [],
	model: { modelId: "gpt-5.4-mini", providerId: "openai" },
	userText: "Inspect the project",
};

describe("ConversationOperation", () => {
	test("returns a successful completion from the application executor", async () => {
		const execute = mock(async (input: ConversationSendInput) => {
			expect(input).toEqual(request);
			return { rejected: false as const };
		});
		const operation = createConversationOperation({ execute });

		expect(await operation.send(request)).toEqual({ rejected: false });
		expect(execute).toHaveBeenCalledTimes(1);
	});

	test("cancels the active send through its abort signal", async () => {
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const execute = mock(
			(_input: ConversationSendInput, signal: AbortSignal) =>
				new Promise<{ rejected: true; reason: string }>((resolve) => {
					const resolveCancelled = () =>
						resolve({ rejected: true, reason: "Cancelled" });
					signal.addEventListener("abort", resolveCancelled, { once: true });
					markStarted?.();
				})
		);
		const operation = createConversationOperation({ execute });

		const send = operation.send(request);
		await started;
		const idle = operation.waitForIdle();
		operation.cancel();
		expect(await idle).toBe(false);

		expect(await send).toEqual({ rejected: true, reason: "Cancelled" });
		expect(execute).toHaveBeenCalledTimes(1);
	});

	test("preserves a gated Tool Call completion through the application seam", async () => {
		const approvalRequests: unknown[] = [];
		const gate = createToolGate({
			openApproval: (request, actions) => {
				approvalRequests.push(request);
				actions.allow(false);
			},
			resolvePermission: async () =>
				createToolPermission({ shell: { "git status": "ask" } }),
			resolveResourceLimits: async () => getToolResourceLimits(),
			sandbox: createWorkspaceSandbox(process.cwd()),
			service: createPermissionService(),
		});
		const committedRecords: Array<{
			agent: ConversationSendInput["agent"];
			attachments: NonNullable<ConversationSendInput["files"]>;
			model: ConversationSendInput["model"];
			toolResult: string;
		}> = [];
		const projectedOutcomes: string[] = [];
		const execute = mock(
			async (input: ConversationSendInput, signal: AbortSignal) => {
				if (signal.aborted) {
					return { rejected: true as const, reason: "Cancelled" };
				}
				const toolCall = {
					family: "shell" as const,
					toolCall: {
						input: { command: "git status" },
						toolCallId: "conversation-operation-shell",
					},
				};
				const outcome = await gate.gate(toolCall);
				if (outcome.kind !== "allow") {
					return { rejected: true as const, reason: outcome.errorText };
				}
				committedRecords.push({
					agent: input.agent,
					attachments: input.files ?? [],
					model: input.model,
					toolResult: "git status completed",
				});
				projectedOutcomes.push("Tool shell completed");
				return { rejected: false as const };
			}
		);
		const operation = createConversationOperation({ execute });
		const attachment = {
			mediaType: "text/plain",
			type: "file" as const,
			url: "data:text/plain;base64,SGk=",
		};

		expect(await operation.send({ ...request, files: [attachment] })).toEqual({
			rejected: false,
		});
		expect(approvalRequests).toHaveLength(1);
		expect(committedRecords).toEqual([
			{
				agent: "build",
				attachments: [attachment],
				model: request.model,
				toolResult: "git status completed",
			},
		]);
		expect(projectedOutcomes).toEqual(["Tool shell completed"]);
	});

	test("does not start a second send while one is active", async () => {
		let resolveFirst: (() => void) | undefined;
		const execute = mock(
			() =>
				new Promise<{ rejected: false }>((resolve) => {
					resolveFirst = () => resolve({ rejected: false });
				})
		);
		const operation = createConversationOperation({ execute });

		const first = operation.send(request);
		await expect(operation.send(request)).resolves.toEqual({
			rejected: true,
			reason: "A conversation send is already active.",
		});
		resolveFirst?.();
		await expect(first).resolves.toEqual({ rejected: false });
		expect(execute).toHaveBeenCalledTimes(1);
	});
});
