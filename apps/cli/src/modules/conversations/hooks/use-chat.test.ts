import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodingAgentUIMessage } from "@wincode/ai";
import type { handleCodingAgentToolCall } from "@wincode/ai/client";
import { createWorkspaceSandbox } from "@wincode/ai/workspace";
import type { ChatAddToolOutputFunction } from "ai";
import type {
	McpCatalogSnapshot,
	McpContextValue,
	McpSnapshotTool,
} from "@/modules/mcp";
import {
	applyManualApprovalSafetyCeiling,
	createPermissionService,
	createToolPermission,
	type ToolPermissionRuntime,
} from "@/modules/permissions";
import { createApprovalQueue } from "@/shared/providers/approval/approval-queue";
import type {
	ToolApprovalActions,
	ToolApprovalRequest,
} from "@/shared/providers/approval/ui/tool-approval-dialog";
import { prepareSendChatRequestBody } from "../api/chat-request";
import {
	createChatMessageParts,
	createChatToolCallHandler,
	createMcpApprovalGate,
	finalizeAssistantMessageMetadata,
	findCurrentTurnAssistantIndex,
	findCurrentTurnInterruptTargetIndex,
	getContinuationChatParams,
	notifyHostedCompletion,
} from "./use-chat";

const selection = {
	modelId: "gemini-2.5-flash",
	providerId: "wincode",
} as const;

const legacyModel = "gemini-3.5-flash";

const userMessage = {
	id: "user-1",
	metadata: { mode: "plan", model: legacyModel },
	parts: [{ text: "hello", type: "text" }],
	role: "user",
} as unknown as CodingAgentUIMessage;

const assistantMessage = {
	id: "assistant-1",
	metadata: { mode: "plan", model: selection },
	parts: [
		{
			input: { path: "README.md" },
			output: { content: "ok", path: "README.md" },
			state: "output-available",
			toolCallId: "call-1",
			type: "tool-read",
		},
	],
	role: "assistant",
} as unknown as CodingAgentUIMessage;

describe("prepareSendChatRequestBody", () => {
	test("normalizes legacy model metadata", () => {
		expect(prepareSendChatRequestBody("session-1", [userMessage])).toEqual({
			messages: [userMessage],
			mode: "plan",
			model: "gemini-2.5-flash",
			persist: false,
			sendReasoning: true,
		});
	});

	test("keeps canonical selection metadata", () => {
		expect(
			prepareSendChatRequestBody("session-1", [userMessage, assistantMessage])
		).toEqual({
			messages: [userMessage, assistantMessage],
			mode: "plan",
			model: "gemini-2.5-flash",
			persist: false,
			sendReasoning: true,
		});
	});

	test("uses fallback metadata when no messages include metadata", () => {
		const nextMessage = {
			id: "user-2",
			parts: [{ text: "continue", type: "text" }],
			role: "user",
		} as unknown as CodingAgentUIMessage;

		expect(
			prepareSendChatRequestBody("session-1", [nextMessage], {
				mode: "build",
				model: selection,
			})
		).toEqual({
			messages: [nextMessage],
			mode: "build",
			model: "gemini-2.5-flash",
			persist: false,
			sendReasoning: true,
		});
	});

	test("throws when no message can be sent", () => {
		expect(() => prepareSendChatRequestBody("session-1", [])).toThrow(
			"No message to send"
		);
	});
});

describe("useChat helpers", () => {
	test("preserves file parts in optimistic and sent part order", () => {
		const mention = {
			data: { path: "src/app.ts" },
			type: "data-fileMention",
		} as unknown as CodingAgentUIMessage["parts"][number];
		const file = {
			mediaType: "text/plain",
			type: "file",
			url: "file:///tmp/input.txt",
		} as const;

		expect(createChatMessageParts("inspect", [mention], [file])).toEqual([
			{ text: "inspect", type: "text" },
			mention,
			file,
		]);
	});

	test("does not interrupt an assistant from the previous turn", () => {
		const optimisticUserMessage = {
			id: "user-2",
			parts: [{ text: "next", type: "text" }],
			role: "user",
		} as CodingAgentUIMessage;

		expect(
			findCurrentTurnAssistantIndex([
				userMessage,
				assistantMessage,
				optimisticUserMessage,
			])
		).toBe(-1);
		expect(
			findCurrentTurnInterruptTargetIndex([
				userMessage,
				assistantMessage,
				optimisticUserMessage,
			])
		).toBe(2);
	});

	test("finds the assistant in the current turn", () => {
		expect(
			findCurrentTurnInterruptTargetIndex([
				userMessage,
				assistantMessage,
				{
					id: "user-2",
					parts: [{ text: "next", type: "text" }],
					role: "user",
				} as CodingAgentUIMessage,
				{
					id: "assistant-2",
					parts: [],
					role: "assistant",
				} as CodingAgentUIMessage,
			])
		).toBe(3);
	});

	test("seeds continuation agent and retains assistant variant metadata", () => {
		expect(getContinuationChatParams("plan", selection, "high")).toEqual({
			agent: "plan",
			model: selection,
			variant: "high",
		});

		expect(
			finalizeAssistantMessageMetadata(
				{
					id: "assistant-2",
					parts: [],
					role: "assistant",
				} as CodingAgentUIMessage,
				{
					agent: "plan",
					interrupted: false,
					mode: "plan",
					model: selection,
					variant: "high",
				}
			)
		).toMatchObject({
			metadata: {
				agent: "plan",
				mode: "plan",
				model: selection,
				variant: "high",
			},
		});
	});

	test("keeps existing assistant variant metadata when continuing", () => {
		expect(
			finalizeAssistantMessageMetadata(
				{
					id: "assistant-3",
					metadata: { model: selection, variant: "low" },
					parts: [],
					role: "assistant",
				} as CodingAgentUIMessage,
				{
					agent: "plan",
					interrupted: true,
					mode: "plan",
					model: selection,
					variant: "high",
				}
			)
		).toMatchObject({
			metadata: {
				agent: "plan",
				interrupted: true,
				mode: "plan",
				model: selection,
				variant: "low",
			},
		});
	});

	test("refreshes billing only after hosted completion", () => {
		let refreshCount = 0;
		const refresh = () => {
			refreshCount += 1;
		};

		notifyHostedCompletion(selection, refresh);
		notifyHostedCompletion(
			{ modelId: "gpt-5.5", providerId: "openai" },
			refresh
		);

		expect(refreshCount).toBe(1);
	});
});

describe("createChatToolCallHandler", () => {
	type ToolOutput = Parameters<
		ChatAddToolOutputFunction<CodingAgentUIMessage>
	>[0];
	const addToolOutput = mock((_config: ToolOutput) => undefined);
	const addToolOutputRef = {
		current:
			addToolOutput as ChatAddToolOutputFunction<CodingAgentUIMessage> | null,
	};
	const modeRef = { current: "build" as const };
	const mcpSnapshotRef = { current: null as McpCatalogSnapshot | null };
	const handleDynamicToolCall = mock(() => undefined);
	const mcp = {
		handleDynamicToolCall,
	} as Pick<McpContextValue, "handleDynamicToolCall">;
	const staticToolCallHandler = mock(() => undefined);
	const openApproval = mock(() => undefined);
	const permissionRef = { current: createToolPermission() };
	const sandbox = createWorkspaceSandbox(process.cwd());

	const makeHandler = (
		overrides: Partial<Parameters<typeof createChatToolCallHandler>[0]> = {}
	) =>
		createChatToolCallHandler({
			addToolOutputRef,
			// Fresh per handler so pending approvals and grants never leak between
			// tests through a shared queue or service.
			approvalQueue: createApprovalQueue<ToolApprovalRequest>(),
			handleCodingAgentToolCall: (() =>
				staticToolCallHandler) as typeof handleCodingAgentToolCall,
			mcp,
			mcpSnapshotRef,
			modeRef,
			openApproval,
			permissionRef,
			sandbox,
			service: createPermissionService(),
			...overrides,
		});

	const call = (toolCall: Record<string, unknown>) =>
		makeHandler()({ toolCall } as never);

	const callWith = (
		toolCall: Record<string, unknown>,
		overrides: Partial<Parameters<typeof createChatToolCallHandler>[0]>
	) => makeHandler(overrides)({ toolCall } as never);

	// The handler never returns its tool-call promise (returning it would
	// deadlock the chat executor), so tests flush the queue to let the
	// fire-and-forget gate settle. The gate awaits a real filesystem
	// canonicalization, so the delay is generous enough to absorb that latency
	// under load and keep these timing-based assertions deterministic.
	const flush = () =>
		new Promise<void>((resolve) => {
			setTimeout(resolve, 75);
		});

	const settleCall = async (result: unknown) => {
		await result;
		await flush();
	};

	afterEach(() => {
		handleDynamicToolCall.mockClear();
		staticToolCallHandler.mockClear();
		openApproval.mockClear();
		addToolOutput.mockClear();
	});

	test("routes dynamic tool calls to handleDynamicToolCall with the active snapshot", () => {
		const snapshot = { id: "snap-1" } as McpCatalogSnapshot;
		mcpSnapshotRef.current = snapshot;

		call({
			dynamic: true,
			input: { text: "hello" },
			toolCallId: "call-1",
			toolName: "mcp_demo_echo",
		});

		expect(handleDynamicToolCall).toHaveBeenCalledWith(
			snapshot,
			expect.objectContaining({ toolName: "mcp_demo_echo" }),
			addToolOutput,
			expect.any(Function)
		);
		expect(staticToolCallHandler).not.toHaveBeenCalled();
	});

	test("routes static tool calls to handleCodingAgentToolCall", async () => {
		await settleCall(
			call({
				input: { path: "src/app.ts" },
				toolCallId: "call-2",
				toolName: "read",
			})
		);

		expect(staticToolCallHandler).toHaveBeenCalled();
		expect(handleDynamicToolCall).not.toHaveBeenCalled();
	});

	test("handles a missing or stale snapshot ref without crashing", () => {
		mcpSnapshotRef.current = null;
		call({
			dynamic: true,
			toolCallId: "call-3",
			toolName: "mcp_demo_echo",
		});
		expect(handleDynamicToolCall).toHaveBeenCalledWith(
			null,
			expect.objectContaining({ toolName: "mcp_demo_echo" }),
			addToolOutput,
			expect.any(Function)
		);

		const stale = { id: "snap-stale" } as McpCatalogSnapshot;
		mcpSnapshotRef.current = stale;
		call({
			dynamic: true,
			toolCallId: "call-4",
			toolName: "mcp_demo_echo",
		});
		expect(handleDynamicToolCall).toHaveBeenCalledWith(
			stale,
			expect.objectContaining({ toolName: "mcp_demo_echo" }),
			addToolOutput,
			expect.any(Function)
		);
	});

	test("returns early when addToolOutput is not yet available", () => {
		addToolOutputRef.current = null;

		call({
			dynamic: true,
			toolCallId: "call-5",
			toolName: "mcp_demo_echo",
		});

		expect(handleDynamicToolCall).not.toHaveBeenCalled();
		expect(staticToolCallHandler).not.toHaveBeenCalled();
		addToolOutputRef.current = addToolOutput;
	});

	test("denies a policy-denied read with an observable error and never runs the tool", async () => {
		await settleCall(
			callWith(
				{
					input: { path: ".env" },
					toolCallId: "call-deny",
					toolName: "read",
				},
				{
					permissionRef: {
						current: createToolPermission({ read: { ".env": "deny" } }),
					},
				}
			)
		);
		expect(staticToolCallHandler).not.toHaveBeenCalled();
		expect(addToolOutput).toHaveBeenCalledWith({
			errorText: "Read denied by policy: .env",
			state: "output-error",
			tool: "read",
			toolCallId: "call-deny",
		});
	});

	test("waits for configured permission before evaluating the read", async () => {
		await settleCall(
			callWith(
				{
					input: { path: ".env" },
					toolCallId: "call-loaded-deny",
					toolName: "read",
				},
				{
					permissionRef: { current: createToolPermission({ read: "allow" }) },
					resolvePermission: async () => createToolPermission({ read: "deny" }),
				}
			)
		);
		expect(staticToolCallHandler).not.toHaveBeenCalled();
		expect(addToolOutput).toHaveBeenCalledWith({
			errorText: "Read denied by policy: .env",
			state: "output-error",
			tool: "read",
			toolCallId: "call-loaded-deny",
		});
	});

	test("asks before .env reads by default and runs after allow once", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wincode-permission-"));
		await writeFile(join(dir, ".env"), "SECRET=1");
		const approvalRequests: ToolApprovalRequest[] = [];
		const open = mock(
			(request: ToolApprovalRequest, actions: ToolApprovalActions) => {
				approvalRequests.push(request);
				// The dialog settles after the gate registers the request.
				queueMicrotask(() => actions.allow(false));
			}
		);

		await settleCall(
			callWith(
				{
					input: { path: ".env" },
					toolCallId: "call-ask",
					toolName: "read",
				},
				{
					openApproval: open,
					permissionRef: { current: createToolPermission() },
					sandbox: createWorkspaceSandbox(dir),
				}
			)
		);
		expect(approvalRequests).toHaveLength(1);
		expect(approvalRequests[0]).toMatchObject({
			description: "Read a UTF-8 text file inside the workspace.",
			identity: [
				{ label: "tool", value: "read" },
				{ label: "resource", value: ".env" },
			],
		});
		expect(staticToolCallHandler).toHaveBeenCalledTimes(1);
		expect(addToolOutput).not.toHaveBeenCalled();
	});

	test("rejects an ask read with an observable error and never runs the tool", async () => {
		const open = mock(
			(_request: ToolApprovalRequest, actions: ToolApprovalActions) => {
				queueMicrotask(() => actions.reject());
			}
		);

		await settleCall(
			callWith(
				{
					input: { path: ".env" },
					toolCallId: "call-reject",
					toolName: "read",
				},
				{
					openApproval: open,
					permissionRef: { current: createToolPermission() },
					sandbox: createWorkspaceSandbox(process.cwd()),
				}
			)
		);
		expect(staticToolCallHandler).not.toHaveBeenCalled();
		expect(addToolOutput).toHaveBeenCalledWith({
			errorText: "Read was not approved: .env",
			state: "output-error",
			tool: "read",
			toolCallId: "call-reject",
		});
	});

	test("cancels an ask read with an observable error and never runs the tool", async () => {
		const open = mock(
			(_request: ToolApprovalRequest, actions: ToolApprovalActions) => {
				queueMicrotask(() => actions.cancel());
			}
		);

		await settleCall(
			callWith(
				{
					input: { path: ".env" },
					toolCallId: "call-cancel",
					toolName: "read",
				},
				{
					openApproval: open,
					permissionRef: { current: createToolPermission() },
					sandbox: createWorkspaceSandbox(process.cwd()),
				}
			)
		);
		expect(staticToolCallHandler).not.toHaveBeenCalled();
		expect(addToolOutput).toHaveBeenCalledWith({
			errorText: "Read was not approved: .env",
			state: "output-error",
			tool: "read",
			toolCallId: "call-cancel",
		});
	});

	test("allows ordinary reads by default without an approval request", async () => {
		await settleCall(
			callWith(
				{
					input: { path: "package.json" },
					toolCallId: "call-allow",
					toolName: "read",
				},
				{
					permissionRef: { current: createToolPermission() },
					sandbox: createWorkspaceSandbox(process.cwd()),
				}
			)
		);
		expect(openApproval).not.toHaveBeenCalled();
		expect(staticToolCallHandler).toHaveBeenCalledTimes(1);
		expect(addToolOutput).not.toHaveBeenCalled();
	});

	test("allows .env.example reads by default", async () => {
		await settleCall(
			callWith(
				{
					input: { path: ".env.example" },
					toolCallId: "call-example",
					toolName: "read",
				},
				{
					permissionRef: { current: createToolPermission() },
					sandbox: createWorkspaceSandbox(process.cwd()),
				}
			)
		);
		expect(openApproval).not.toHaveBeenCalled();
		expect(staticToolCallHandler).toHaveBeenCalledTimes(1);
		expect(addToolOutput).not.toHaveBeenCalled();
	});

	test("canonicalizes the read resource through the sandbox before matching", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wincode-canonical-"));
		await writeFile(join(dir, ".env"), "SECRET=1");
		await symlink(join(dir, ".env"), join(dir, "link.env"));
		const open = mock(
			(_request: ToolApprovalRequest, actions: ToolApprovalActions) => {
				queueMicrotask(() => actions.reject());
			}
		);

		await settleCall(
			callWith(
				{
					input: { path: "link.env" },
					toolCallId: "call-canonical",
					toolName: "read",
				},
				{
					openApproval: open,
					permissionRef: { current: createToolPermission() },
					sandbox: createWorkspaceSandbox(dir),
				}
			)
		);
		expect(open).toHaveBeenCalled();
		expect(addToolOutput).toHaveBeenCalledWith({
			errorText: "Read was not approved: .env",
			state: "output-error",
			tool: "read",
			toolCallId: "call-canonical",
		});
		expect(staticToolCallHandler).not.toHaveBeenCalled();
	});

	test("rejects paths outside the workspace before running the tool", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wincode-outside-"));
		await settleCall(
			callWith(
				{
					input: { path: "../outside.txt" },
					toolCallId: "call-outside",
					toolName: "read",
				},
				{
					permissionRef: { current: createToolPermission({ read: "allow" }) },
					sandbox: createWorkspaceSandbox(dir),
				}
			)
		);
		expect(staticToolCallHandler).not.toHaveBeenCalled();
		expect(addToolOutput).toHaveBeenCalledWith({
			errorText: "Read path is outside the workspace: ../outside.txt",
			state: "output-error",
			tool: "read",
			toolCallId: "call-outside",
		});
	});

	test("executes the real static tool runner only when the policy allows", async () => {
		const handler = createChatToolCallHandler({
			addToolOutputRef,
			approvalQueue: createApprovalQueue<ToolApprovalRequest>(),
			mcp,
			mcpSnapshotRef,
			modeRef,
			openApproval: mock(() => undefined),
			permissionRef: {
				current: createToolPermission({ read: { ".env": "deny" } }),
			},
			sandbox: createWorkspaceSandbox(),
			service: createPermissionService(),
		});

		await settleCall(
			handler({
				toolCall: {
					input: { path: "apps/cli/.env" },
					toolCallId: "call-real-deny",
					toolName: "read",
				},
			} as never)
		);

		expect(addToolOutput).toHaveBeenCalledWith({
			errorText: "Read denied by policy: apps/cli/.env",
			state: "output-error",
			tool: "read",
			toolCallId: "call-real-deny",
		});

		await settleCall(
			handler({
				toolCall: {
					input: { path: "package.json" },
					toolCallId: "call-real-allow",
					toolName: "read",
				},
			} as never)
		);

		expect(addToolOutput.mock.calls.map(([output]) => output)).toContainEqual(
			expect.objectContaining({
				output: expect.objectContaining({
					content: expect.stringContaining("name"),
					path: "package.json",
				}),
				tool: "read",
				toolCallId: "call-real-allow",
			})
		);
	});

	test("denies a write through the edit action and never runs the tool", async () => {
		await settleCall(
			callWith(
				{
					input: { content: "SECRET=1", path: "secret.txt" },
					toolCallId: "call-write-deny",
					toolName: "write",
				},
				{
					permissionRef: { current: createToolPermission({ edit: "deny" }) },
					sandbox: createWorkspaceSandbox(process.cwd()),
				}
			)
		);
		expect(staticToolCallHandler).not.toHaveBeenCalled();
		expect(addToolOutput).toHaveBeenCalledWith({
			errorText: "Write denied by policy: secret.txt",
			state: "output-error",
			tool: "write",
			toolCallId: "call-write-deny",
		});
	});

	test("denies an edit through the edit action and never runs the tool", async () => {
		await settleCall(
			callWith(
				{
					input: { find: "a", path: "src/app.ts", replace: "b" },
					toolCallId: "call-edit-deny",
					toolName: "edit",
				},
				{
					permissionRef: {
						current: createToolPermission({ edit: { "src/*": "deny" } }),
					},
					sandbox: createWorkspaceSandbox(process.cwd()),
				}
			)
		);
		expect(staticToolCallHandler).not.toHaveBeenCalled();
		expect(addToolOutput).toHaveBeenCalledWith({
			errorText: "Edit denied by policy: src/app.ts",
			state: "output-error",
			tool: "edit",
			toolCallId: "call-edit-deny",
		});
	});

	test("gates list against its default workspace-root resource", async () => {
		await settleCall(
			callWith(
				{
					input: {},
					toolCallId: "call-list-deny",
					toolName: "list",
				},
				{
					permissionRef: { current: createToolPermission({ list: "deny" }) },
					sandbox: createWorkspaceSandbox(process.cwd()),
				}
			)
		);
		expect(staticToolCallHandler).not.toHaveBeenCalled();
		expect(addToolOutput).toHaveBeenCalledWith({
			errorText: "List denied by policy: .",
			state: "output-error",
			tool: "list",
			toolCallId: "call-list-deny",
		});
	});

	test("gates grep against its requested regular expression", async () => {
		await settleCall(
			callWith(
				{
					input: { pattern: "TODO.*" },
					toolCallId: "call-grep-deny",
					toolName: "grep",
				},
				{
					permissionRef: {
						current: createToolPermission({ grep: { "TODO.*": "deny" } }),
					},
					sandbox: createWorkspaceSandbox(process.cwd()),
				}
			)
		);
		expect(staticToolCallHandler).not.toHaveBeenCalled();
		expect(addToolOutput).toHaveBeenCalledWith({
			errorText: "Grep denied by policy: TODO.*",
			state: "output-error",
			tool: "grep",
			toolCallId: "call-grep-deny",
		});
	});

	test("asks before a write and runs after allow once", async () => {
		const approvalRequests: ToolApprovalRequest[] = [];
		const open = mock(
			(request: ToolApprovalRequest, actions: ToolApprovalActions) => {
				approvalRequests.push(request);
				queueMicrotask(() => actions.allow(false));
			}
		);

		await settleCall(
			callWith(
				{
					input: { content: "x", path: "notes.txt" },
					toolCallId: "call-write-ask",
					toolName: "write",
				},
				{
					openApproval: open,
					permissionRef: { current: createToolPermission({ edit: "ask" }) },
					sandbox: createWorkspaceSandbox(process.cwd()),
				}
			)
		);
		expect(approvalRequests[0]).toMatchObject({
			description:
				"Create or overwrite a UTF-8 text file inside the workspace. Parent directories are created inside the workspace.",
			identity: [
				{ label: "tool", value: "write" },
				{ label: "resource", value: "notes.txt" },
			],
		});
		expect(staticToolCallHandler).toHaveBeenCalledTimes(1);
		expect(addToolOutput).not.toHaveBeenCalled();
	});

	test("an always grant skips later approvals for the exact resource", async () => {
		const service = createPermissionService();
		const permissionRef = { current: createToolPermission({ edit: "ask" }) };
		const sandbox = createWorkspaceSandbox(process.cwd());
		const open = mock(
			(_request: ToolApprovalRequest, actions: ToolApprovalActions) => {
				// Remember the grant on the first approval.
				queueMicrotask(() => actions.allow(true));
			}
		);

		await settleCall(
			callWith(
				{
					input: { content: "x", path: "notes.txt" },
					toolCallId: "call-grant-1",
					toolName: "write",
				},
				{ openApproval: open, permissionRef, sandbox, service }
			)
		);
		expect(open).toHaveBeenCalledTimes(1);
		expect(service.isGranted("edit", "notes.txt")).toBe(true);

		// The second call for the same action/resource is not prompted again.
		await settleCall(
			callWith(
				{
					input: { content: "y", path: "notes.txt" },
					toolCallId: "call-grant-2",
					toolName: "write",
				},
				{ openApproval: open, permissionRef, sandbox, service }
			)
		);
		expect(open).toHaveBeenCalledTimes(1);
		expect(staticToolCallHandler).toHaveBeenCalledTimes(2);
		expect(addToolOutput).not.toHaveBeenCalled();
	});

	test("auto approval satisfies an ordinary ask without a dialog", async () => {
		await settleCall(
			callWith(
				{
					input: { content: "x", path: "notes.txt" },
					toolCallId: "call-auto",
					toolName: "write",
				},
				{
					permissionRef: { current: createToolPermission({ edit: "ask" }) },
					sandbox: createWorkspaceSandbox(process.cwd()),
					service: createPermissionService({ autoApproval: true }),
				}
			)
		);
		expect(openApproval).not.toHaveBeenCalled();
		expect(staticToolCallHandler).toHaveBeenCalledTimes(1);
		expect(addToolOutput).not.toHaveBeenCalled();
	});

	test("auto approval and grants never bypass an explicit deny", async () => {
		const service = createPermissionService({ autoApproval: true });
		service.grant("edit", "notes.txt");
		await settleCall(
			callWith(
				{
					input: { content: "x", path: "notes.txt" },
					toolCallId: "call-deny-auto",
					toolName: "write",
				},
				{
					permissionRef: { current: createToolPermission({ edit: "deny" }) },
					sandbox: createWorkspaceSandbox(process.cwd()),
					service,
				}
			)
		);
		expect(openApproval).not.toHaveBeenCalled();
		expect(staticToolCallHandler).not.toHaveBeenCalled();
		expect(addToolOutput).toHaveBeenCalledWith({
			errorText: "Write denied by policy: notes.txt",
			state: "output-error",
			tool: "write",
			toolCallId: "call-deny-auto",
		});
	});

	test("a safety ask is not bypassed by auto approval or a grant", async () => {
		const service = createPermissionService({ autoApproval: true });
		service.grant("edit", "notes.txt");
		const open = mock(
			(_request: ToolApprovalRequest, actions: ToolApprovalActions) => {
				queueMicrotask(() => actions.reject());
			}
		);
		await settleCall(
			callWith(
				{
					input: { content: "x", path: "notes.txt" },
					toolCallId: "call-safety",
					toolName: "write",
				},
				{
					openApproval: open,
					permissionRef: {
						current: applyManualApprovalSafetyCeiling(
							createToolPermission({ edit: "allow" })
						),
					},
					sandbox: createWorkspaceSandbox(process.cwd()),
					service,
				}
			)
		);
		// The manual-only ceiling forces the dialog even with auto + grant present.
		expect(open).toHaveBeenCalledTimes(1);
		expect(staticToolCallHandler).not.toHaveBeenCalled();
	});

	test("returns bounded rejection feedback to the agent", async () => {
		const open = mock(
			(_request: ToolApprovalRequest, actions: ToolApprovalActions) => {
				queueMicrotask(() => actions.reject(`  ${"z".repeat(4096)}  `));
			}
		);
		await settleCall(
			callWith(
				{
					input: { content: "x", path: "notes.txt" },
					toolCallId: "call-feedback",
					toolName: "write",
				},
				{
					openApproval: open,
					permissionRef: { current: createToolPermission({ edit: "ask" }) },
					sandbox: createWorkspaceSandbox(process.cwd()),
				}
			)
		);
		expect(staticToolCallHandler).not.toHaveBeenCalled();
		const call = addToolOutput.mock.calls.at(0)?.[0] as
			| { errorText: string }
			| undefined;
		expect(
			call?.errorText.startsWith("Write was not approved: notes.txt — ")
		).toBe(true);
		// Bounded: 2048 feedback chars plus the overflow marker, never the full 4096.
		expect(call?.errorText.length).toBeLessThan(2200);
	});

	test("allows write, edit, list, and grep by default without approval", async () => {
		const calls = [
			{
				input: { content: "x", path: "notes.txt" },
				toolCallId: "call-write-allow",
				toolName: "write",
			},
			{
				input: { find: "a", path: "notes.txt", replace: "b" },
				toolCallId: "call-edit-allow",
				toolName: "edit",
			},
			{ input: {}, toolCallId: "call-list-allow", toolName: "list" },
			{
				input: { pattern: "TODO" },
				toolCallId: "call-grep-allow",
				toolName: "grep",
			},
		];

		for (const toolCall of calls) {
			await settleCall(
				callWith(toolCall, {
					permissionRef: { current: createToolPermission() },
					sandbox: createWorkspaceSandbox(process.cwd()),
				})
			);
		}

		expect(openApproval).not.toHaveBeenCalled();
		expect(staticToolCallHandler).toHaveBeenCalledTimes(calls.length);
		expect(addToolOutput).not.toHaveBeenCalled();
	});
});

describe("createMcpApprovalGate", () => {
	const makeTool = (
		overrides: Partial<McpSnapshotTool> = {}
	): McpSnapshotTool =>
		({
			description: "Echo the input",
			logicalName: "demo_echo",
			originalToolName: "echo",
			policy: "allow",
			safety: false,
			serverName: "demo",
			...overrides,
		}) as McpSnapshotTool;

	const gateDeps = (
		openApproval: ToolPermissionRuntimeOpenApproval,
		service = createPermissionService()
	) => ({
		approvalQueue: createApprovalQueue<ToolApprovalRequest>(),
		openApproval,
		service,
	});

	type ToolPermissionRuntimeOpenApproval =
		ToolPermissionRuntime["openApproval"];

	const neverPrompt: ToolPermissionRuntimeOpenApproval = () => {
		throw new Error("openApproval must not be called for a non-ask decision");
	};

	test("allows an allow-policy tool without prompting", async () => {
		const gate = createMcpApprovalGate(gateDeps(neverPrompt));
		await expect(gate(makeTool({ policy: "allow" }), {})).resolves.toEqual({
			kind: "allow",
		});
	});

	test("denies a deny-policy tool without prompting", async () => {
		const gate = createMcpApprovalGate(gateDeps(neverPrompt));
		await expect(gate(makeTool({ policy: "deny" }), {})).resolves.toEqual({
			kind: "deny",
		});
	});

	test("auto approval satisfies an ordinary ask without prompting", async () => {
		const service = createPermissionService({ autoApproval: true });
		const gate = createMcpApprovalGate(gateDeps(neverPrompt, service));
		await expect(gate(makeTool({ policy: "ask" }), {})).resolves.toEqual({
			kind: "allow",
		});
	});

	test("a matching temporary grant satisfies an ask without prompting", async () => {
		const service = createPermissionService();
		service.grant("demo_echo", "*");
		const gate = createMcpApprovalGate(gateDeps(neverPrompt, service));
		await expect(gate(makeTool({ policy: "ask" }), {})).resolves.toEqual({
			kind: "allow",
		});
	});

	test("a safety ask always prompts even under auto approval", async () => {
		const service = createPermissionService({ autoApproval: true });
		let prompted = false;
		const openApproval: ToolPermissionRuntimeOpenApproval = (
			_request,
			actions
		) => {
			prompted = true;
			actions.allow(false);
		};
		const gate = createMcpApprovalGate(gateDeps(openApproval, service));
		await expect(
			gate(makeTool({ policy: "ask", safety: true }), {})
		).resolves.toEqual({ kind: "allow" });
		expect(prompted).toBe(true);
	});

	test("an interactive allow with remember records a grant for the logical name", async () => {
		const service = createPermissionService();
		const openApproval: ToolPermissionRuntimeOpenApproval = (
			request,
			actions
		) => {
			// The dialog identifies the tool by its logical name and the wildcard
			// resource, not the hashed dispatch name.
			expect(request.identity).toEqual([
				{ label: "tool", value: "demo_echo" },
				{ label: "resource", value: "*" },
			]);
			actions.allow(true);
		};
		const gate = createMcpApprovalGate(gateDeps(openApproval, service));
		await expect(gate(makeTool({ policy: "ask" }), {})).resolves.toEqual({
			kind: "allow",
		});
		expect(service.isGranted("demo_echo", "*")).toBe(true);
	});

	test("a rejection carries the typed feedback back to the agent", async () => {
		const openApproval: ToolPermissionRuntimeOpenApproval = (
			_request,
			actions
		) => {
			actions.reject("use the read tool instead");
		};
		const gate = createMcpApprovalGate(gateDeps(openApproval));
		await expect(gate(makeTool({ policy: "ask" }), {})).resolves.toEqual({
			feedback: "use the read tool instead",
			kind: "reject",
		});
	});

	test("a cancel rejects without feedback and grants nothing", async () => {
		const service = createPermissionService();
		const openApproval: ToolPermissionRuntimeOpenApproval = (
			_request,
			actions
		) => {
			actions.cancel();
		};
		const gate = createMcpApprovalGate(gateDeps(openApproval, service));
		await expect(gate(makeTool({ policy: "ask" }), {})).resolves.toEqual({
			kind: "reject",
		});
		expect(service.isGranted("demo_echo", "*")).toBe(false);
	});
});
