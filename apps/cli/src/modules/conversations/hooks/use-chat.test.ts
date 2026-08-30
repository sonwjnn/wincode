import { afterEach, describe, expect, mock, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type CodingAgentUIMessage,
	codingToolDefinitions,
	getToolResourceLimits,
	type ResolvedAgentRuntime,
} from "@wincode/ai";
import { handleCodingAgentToolCall } from "@wincode/ai/client";
import { createWorkspaceSandbox } from "@wincode/ai/workspace";
import type { ChatAddToolOutputFunction } from "ai";
import type { PreparedAgentCall } from "@/modules/agents";
import type {
	McpAddToolOutput,
	McpCatalogSnapshot,
	McpContextValue,
} from "@/modules/mcp";
import {
	applyManualApprovalSafetyCeiling,
	canonicalizeExternalPath,
	createPermissionService,
	createToolPermission,
	type PermissionDecision,
	type ToolPermission,
	type ToolPermissionRuntime,
} from "@/modules/permissions";
import {
	buildSkillCatalog,
	createSkillExecution,
	hashSkillBody,
	type SkillExecution,
} from "@/modules/skills";
import {
	createToolGate,
	type ToolGate,
	type ToolGateDeps,
} from "@/modules/tool-gate/tool-gate";
import { createApprovalQueue } from "@/shared/providers/approval/approval-queue";
import type {
	ToolApprovalActions,
	ToolApprovalRequest,
} from "@/shared/providers/approval/types";
import { prepareSendChatRequestBody } from "../api/chat-request";
import { createChatToolCallHandler as createProductionChatToolCallHandler } from "./tool-dispatch";
import {
	activateExplicitSkill,
	createChatMessageParts,
	finalizeAssistantMessageMetadata,
	findCurrentTurnAssistantIndex,
	findCurrentTurnInterruptTargetIndex,
	notifyHostedCompletion,
	sanitizeInterruptedMessagesForConversation,
	sanitizeSkillToolParts,
} from "./use-chat";

type TestChatToolCallHandlerDeps = Omit<
	Parameters<typeof createProductionChatToolCallHandler>[0],
	"gate"
> &
	Omit<ToolGateDeps, "approvalQueue" | "resolvePermission"> & {
		approvalQueue?: ToolGateDeps["approvalQueue"];
		gate?: ToolGate;
		permissionRef: { current: ToolPermission };
		resolvePermission?: ToolGateDeps["resolvePermission"];
	};

const createChatToolCallHandler = ({
	approvalQueue,
	gate,
	openApproval,
	permissionRef,
	resolvePermission,
	resolveResourceLimits,
	sandbox,
	service,
	...deps
}: TestChatToolCallHandlerDeps) =>
	createProductionChatToolCallHandler({
		...deps,
		resolveResourceLimits,
		gate:
			gate ??
			createToolGate({
				approvalQueue,
				openApproval,
				resolvePermission:
					resolvePermission ?? (() => Promise.resolve(permissionRef.current)),
				resolveResourceLimits,
				sandbox,
				service,
			}),
	});

const selection = {
	modelId: "gemini-2.5-flash",
	providerId: "wincode",
} as const;

const legacyModel = "gemini-3.5-flash";
const planPrepared: PreparedAgentCall = {
	agent: "plan",
	model: selection,
	variant: undefined,
	resolvedAgent: {
		instructions: "Plan without editing.",
		visibleCodingTools: ["read", "list", "glob", "grep"],
	},
	hostedDescriptor: {
		billingKind: "plan",
		instructions: "Plan without editing.",
		mcpTools: [],
		visibleCodingTools: ["read", "list", "glob", "grep"],
	},
};

const userMessage = {
	id: "user-1",
	metadata: { agent: "plan", model: legacyModel },
	parts: [{ text: "hello", type: "text" }],
	role: "user",
} as unknown as CodingAgentUIMessage;

const assistantMessage = {
	id: "assistant-1",
	metadata: { agent: "plan", model: selection },
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
	const privateAgentStripped = (
		message: CodingAgentUIMessage
	): CodingAgentUIMessage => {
		const { agent: _agent, ...metadata } = message.metadata ?? {};
		return { ...message, metadata };
	};

	test("normalizes legacy model metadata", () => {
		expect(
			prepareSendChatRequestBody("session-1", [userMessage], planPrepared)
		).toEqual({
			agent: {
				billingKind: "plan",
				instructions: "Plan without editing.",
				mcpTools: [],
				visibleCodingTools: ["read", "list", "glob", "grep"],
			},
			messages: [privateAgentStripped(userMessage)],
			model: "gemini-2.5-flash",
			persist: false,
			sendReasoning: true,
		});
	});

	test("keeps canonical selection metadata", () => {
		expect(
			prepareSendChatRequestBody(
				"session-1",
				[userMessage, assistantMessage],
				planPrepared
			)
		).toEqual({
			agent: {
				billingKind: "plan",
				instructions: "Plan without editing.",
				mcpTools: [],
				visibleCodingTools: ["read", "list", "glob", "grep"],
			},
			messages: [
				privateAgentStripped(userMessage),
				privateAgentStripped(assistantMessage),
			],
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
				...planPrepared,
				agent: "build",
				resolvedAgent: {
					instructions: "Build safely.",
					visibleCodingTools: ["read", "write", "edit", "list", "glob", "grep"],
				},
				hostedDescriptor: {
					billingKind: "build",
					instructions: "Build safely.",
					mcpTools: [],
					visibleCodingTools: ["read", "write", "edit", "list", "glob", "grep"],
				},
			})
		).toEqual({
			agent: {
				billingKind: "build",
				instructions: "Build safely.",
				mcpTools: [],
				visibleCodingTools: ["read", "write", "edit", "list", "glob", "grep"],
			},
			messages: [nextMessage],
			model: "gemini-2.5-flash",
			persist: false,
			sendReasoning: true,
		});
	});

	test("throws when no message can be sent", () => {
		expect(() =>
			prepareSendChatRequestBody("session-1", [], planPrepared)
		).toThrow("No message to send");
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

	test("retains assistant variant metadata", () => {
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
					model: selection,
					variant: "high",
				}
			)
		).toMatchObject({
			metadata: {
				agent: "plan",
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
					model: selection,
					variant: "high",
				}
			)
		).toMatchObject({
			metadata: {
				agent: "plan",
				interrupted: true,
				model: selection,
				variant: "low",
			},
		});
	});

	test("keeps an aborted approval visible for its late tool error", () => {
		const interruptedAssistant = {
			id: "assistant-approval",
			metadata: { interrupted: true },
			parts: [
				{
					input: { path: "/outside/settings.json" },
					state: "input-available",
					toolCallId: "call-read",
					type: "tool-read",
				},
			],
			role: "assistant",
		} satisfies CodingAgentUIMessage;

		const [, sanitized] = sanitizeInterruptedMessagesForConversation(
			[userMessage, interruptedAssistant],
			"call-read"
		);

		expect(sanitized).toMatchObject({
			id: "assistant-approval",
			metadata: { interrupted: true },
			parts: [
				{
					errorText: "Tool call interrupted",
					state: "output-error",
					toolCallId: "call-read",
				},
			],
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
	type DynamicToolOutput = Parameters<McpAddToolOutput>[0];
	const addToolOutput = mock(
		(_config: ToolOutput | DynamicToolOutput) => undefined
	);
	const addToolOutputRef: {
		current: ChatAddToolOutputFunction<CodingAgentUIMessage> | null;
	} = {
		current: addToolOutput,
	};
	const dynamicToolOutputRef: { current: McpAddToolOutput | null } = {
		current: addToolOutput,
	};
	const resolvedAgentRef = {
		current: undefined as ResolvedAgentRuntime | undefined,
	};
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
			dynamicToolOutputRef,
			// Fresh per handler so pending approvals and grants never leak between
			// tests through a shared queue or service.
			approvalQueue: createApprovalQueue<ToolApprovalRequest>(),
			handleCodingAgentToolCall: (() =>
				staticToolCallHandler) as typeof handleCodingAgentToolCall,
			mcp,
			mcpSnapshotRef,
			openApproval,
			permissionRef,
			resolvedAgentRef,
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
	test("passes the active resource profile to static tool execution", async () => {
		const gatedHandler = mock(
			(..._arguments_: Parameters<typeof handleCodingAgentToolCall>) =>
				staticToolCallHandler
		) as typeof handleCodingAgentToolCall;
		const resourceLimits = getToolResourceLimits("extended");

		await settleCall(
			callWith(
				{
					input: { path: "src/app.ts" },
					toolCallId: "call-extended-profile",
					toolName: "read",
				},
				{
					handleCodingAgentToolCall: gatedHandler,
					openApproval: (_request, actions) => actions.allow(false),
					resolveResourceLimits: async () => resourceLimits,
				}
			)
		);

		expect(gatedHandler).toHaveBeenCalledWith(addToolOutput, [], {
			allowExternalPaths: false,
			resourceLimits,
		});
	});

	test("fails closed when the resolved Agent is unavailable", async () => {
		const gatedHandler = mock(
			(..._arguments_: Parameters<typeof handleCodingAgentToolCall>) =>
				staticToolCallHandler
		) as typeof handleCodingAgentToolCall;

		await settleCall(
			callWith(
				{
					input: { path: "src/app.ts" },
					toolCallId: "call-unresolved-agent",
					toolName: "read",
				},
				{
					handleCodingAgentToolCall: gatedHandler,
					resolvedAgentRef: { current: undefined },
				}
			)
		);

		expect(gatedHandler).toHaveBeenCalledWith(addToolOutput, [], {
			allowExternalPaths: false,
		});
	});

	test("executes an approved external read with the gate's canonical path", async () => {
		const canonicalPath = join(tmpdir(), "approved-settings.json");
		const gate = {
			gate: mock(async () => ({
				input: { path: canonicalPath },
				kind: "allow" as const,
			})),
		};
		const gatedHandler = mock(
			(..._arguments_: Parameters<typeof handleCodingAgentToolCall>) =>
				staticToolCallHandler
		) as typeof handleCodingAgentToolCall;

		await settleCall(
			callWith(
				{
					input: { path: "~/.claude/settings.json" },
					toolCallId: "call-home-read",
					toolName: "read",
				},
				{ gate, handleCodingAgentToolCall: gatedHandler }
			)
		);

		expect(gatedHandler).toHaveBeenCalledWith(addToolOutput, [], {
			allowExternalPaths: true,
		});
		expect(staticToolCallHandler).toHaveBeenCalledWith({
			toolCall: {
				input: { path: canonicalPath },
				toolCallId: "call-home-read",
				toolName: "read",
			},
		});
	});

	test("reads an approved home-relative path end to end", async () => {
		const filename = `.wincode-approved-read-${crypto.randomUUID()}`;
		const absolutePath = join(homedir(), filename);
		await writeFile(absolutePath, "approved home content");
		try {
			await settleCall(
				callWith(
					{
						input: { path: `~/${filename}` },
						toolCallId: "call-approved-home-read",
						toolName: "read",
					},
					{
						handleCodingAgentToolCall,
						openApproval: (_request, actions) => actions.allow(false),
						permissionRef: { current: createToolPermission() },
						resolvedAgentRef: {
							current: {
								...planPrepared.resolvedAgent,
								visibleCodingTools: ["read"],
							},
						},
					}
				)
			);

			expect(addToolOutput).toHaveBeenCalledWith({
				output: {
					content: "1:approved home content",
					path: absolutePath,
				},
				tool: "read",
				toolCallId: "call-approved-home-read",
			});
		} finally {
			await rm(absolutePath, { force: true });
		}
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
			description:
				"Read a UTF-8 text file with numbered lines, or an existing directory as a compact two-level tree (directories first, twelve children max, omissions reported). Selectors :N, :N-M, :N+K, :N-, or comma-separated ranges address file lines or directory entries; omission notices do not consume positions. Existing literal paths take precedence. Preserve ~ paths; never guess an absolute home. If you are unsure of a file path, use glob first.",
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

	test("denies paths outside the workspace when external_directory is denied", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wincode-outside-"));
		await settleCall(
			callWith(
				{
					input: { path: "../outside.txt" },
					toolCallId: "call-outside",
					toolName: "read",
				},
				{
					permissionRef: {
						current: createToolPermission({
							external_directory: "deny",
							read: "allow",
						}),
					},
					sandbox: createWorkspaceSandbox(dir),
				}
			)
		);
		expect(staticToolCallHandler).not.toHaveBeenCalled();
		expect(addToolOutput).toHaveBeenCalledWith({
			errorText: `Read denied by policy: ${await canonicalizeExternalPath(
				"../outside.txt",
				dir
			)}`,
			state: "output-error",
			tool: "read",
			toolCallId: "call-outside",
		});
	});

	test("asks before reading paths outside the workspace by default", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wincode-outside-ask-"));
		const approvalRequests: ToolApprovalRequest[] = [];
		const open = mock((request: ToolApprovalRequest, actions) => {
			approvalRequests.push(request);
			queueMicrotask(() => actions.allow(false));
		});
		await settleCall(
			callWith(
				{
					input: { path: "../outside.txt" },
					toolCallId: "call-outside-ask",
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
			identity: [
				{ label: "tool", value: "read" },
				{
					label: "resource",
					value: await canonicalizeExternalPath("../outside.txt", dir),
				},
				{ label: "scope", value: "external" },
			],
		});
		expect(staticToolCallHandler).toHaveBeenCalledTimes(1);
	});

	test("executes the real static tool runner only when the policy allows", async () => {
		const handler = createChatToolCallHandler({
			addToolOutputRef,
			dynamicToolOutputRef,
			approvalQueue: createApprovalQueue<ToolApprovalRequest>(),
			mcp,
			mcpSnapshotRef,
			openApproval: mock(() => undefined),
			permissionRef: {
				current: createToolPermission({ read: { ".env": "deny" } }),
			},
			resolvedAgentRef: {
				current: {
					instructions: "Read files.",
					visibleCodingTools: ["read"],
				},
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
	test("gates glob against its requested path pattern", async () => {
		await settleCall(
			callWith(
				{
					input: { pattern: "src/**/*.ts" },
					toolCallId: "call-glob-deny",
					toolName: "glob",
				},
				{
					permissionRef: {
						current: createToolPermission({
							glob: { "src/**/*.ts": "deny" },
						}),
					},
					sandbox: createWorkspaceSandbox(process.cwd()),
				}
			)
		);
		expect(staticToolCallHandler).not.toHaveBeenCalled();
		expect(addToolOutput).toHaveBeenCalledWith({
			errorText: "Glob denied by policy: src/**/*.ts",
			state: "output-error",
			tool: "glob",
			toolCallId: "call-glob-deny",
		});
	});
	test("denies external glob scopes before approval", async () => {
		const open = mock(() => undefined);
		await settleCall(
			callWith(
				{
					input: { path: "../outside", pattern: "*.ts" },
					toolCallId: "call-glob-external",
					toolName: "glob",
				},
				{
					openApproval: open,
					permissionRef: { current: createToolPermission() },
					sandbox: createWorkspaceSandbox(process.cwd()),
				}
			)
		);

		expect(open).not.toHaveBeenCalled();
		expect(staticToolCallHandler).not.toHaveBeenCalled();
		expect(addToolOutput).toHaveBeenCalledWith({
			errorText: "Glob path is outside the workspace: ../outside",
			state: "output-error",
			tool: "glob",
			toolCallId: "call-glob-external",
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
				"Create or completely rewrite a UTF-8 text file inside the workspace. Existing files are overwritten; prefer edit for targeted changes. Parent directories are created inside the workspace.",
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

	test("allows write, edit, list, glob, and grep by default without approval", async () => {
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
				input: { pattern: "*.ts" },
				toolCallId: "call-glob-allow",
				toolName: "glob",
			},
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

describe("shell tool gating", () => {
	type ToolOutput = Parameters<
		ChatAddToolOutputFunction<CodingAgentUIMessage>
	>[0];
	type DynamicToolOutput = Parameters<McpAddToolOutput>[0];
	const addToolOutput = mock(
		(_config: ToolOutput | DynamicToolOutput) => undefined
	);
	const addToolOutputRef: {
		current: ChatAddToolOutputFunction<CodingAgentUIMessage> | null;
	} = {
		current: addToolOutput,
	};
	const dynamicToolOutputRef: { current: McpAddToolOutput | null } = {
		current: addToolOutput,
	};
	const mcpSnapshotRef = { current: null as McpCatalogSnapshot | null };
	const handleDynamicToolCall = mock(() => undefined);
	const mcp = {
		handleDynamicToolCall,
	} as Pick<McpContextValue, "handleDynamicToolCall">;
	const staticToolCallHandler = mock(() => undefined);
	const openApproval = mock(() => undefined);
	const sandbox = createWorkspaceSandbox(process.cwd());

	const makeHandler = (
		overrides: Partial<Parameters<typeof createChatToolCallHandler>[0]> = {}
	) =>
		createChatToolCallHandler({
			addToolOutputRef,
			dynamicToolOutputRef,
			approvalQueue: createApprovalQueue<ToolApprovalRequest>(),
			handleCodingAgentToolCall: (() =>
				staticToolCallHandler) as typeof handleCodingAgentToolCall,
			mcp,
			mcpSnapshotRef,
			openApproval,
			permissionRef: { current: createToolPermission() },
			resolvedAgentRef: {
				current: {
					instructions: "Run commands.",
					visibleCodingTools: [
						"read",
						"write",
						"edit",
						"list",
						"grep",
						"shell",
					],
				},
			},
			sandbox,
			service: createPermissionService(),
			...overrides,
		});

	const settleCallWith = async (
		toolCall: Record<string, unknown>,
		overrides: Partial<Parameters<typeof createChatToolCallHandler>[0]>
	) => {
		makeHandler(overrides)({ toolCall } as never);
		await new Promise((resolve) => setTimeout(resolve, 75));
	};

	afterEach(() => {
		staticToolCallHandler.mockClear();
		openApproval.mockClear();
		addToolOutput.mockClear();
	});

	test("runs an ordinary shell command without approval by default", async () => {
		await settleCallWith(
			{
				input: { command: "bun test" },
				toolCallId: "call-shell-ask",
				toolName: "shell",
			},
			{}
		);
		expect(openApproval).not.toHaveBeenCalled();
		expect(staticToolCallHandler).toHaveBeenCalledTimes(1);
		expect(addToolOutput).not.toHaveBeenCalled();
	});

	test("asks before a shell ask-gated command and runs after allow once", async () => {
		const requests: ToolApprovalRequest[] = [];
		const approval = mock(
			(request: ToolApprovalRequest, actions: ToolApprovalActions) => {
				requests.push(request);
				queueMicrotask(() => actions.allow(false));
			}
		);

		await settleCallWith(
			{
				input: { command: "bun test" },
				toolCallId: "call-shell-ask",
				toolName: "shell",
			},
			{
				openApproval: approval,
				permissionRef: {
					current: createToolPermission({ shell: "ask" }),
				},
			}
		);

		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			description: codingToolDefinitions.shell.description,
			identity: [
				{ label: "tool", value: "shell" },
				{ label: "resource", value: "bun test" },
			],
		});
		expect(staticToolCallHandler).toHaveBeenCalledTimes(1);
		expect(addToolOutput).not.toHaveBeenCalled();
	});

	test("denies a policy-denied shell command with an observable error", async () => {
		await settleCallWith(
			{
				input: { command: "bun test" },
				toolCallId: "call-shell-deny",
				toolName: "shell",
			},
			{
				permissionRef: {
					current: createToolPermission({ shell: "deny" }),
				},
			}
		);
		expect(openApproval).not.toHaveBeenCalled();
		expect(staticToolCallHandler).not.toHaveBeenCalled();
		expect(addToolOutput).toHaveBeenCalledWith({
			errorText: "Shell denied by policy: bun test",
			state: "output-error",
			tool: "shell",
			toolCallId: "call-shell-deny",
		});
	});

	test("rejects a shell ask with an observable error and never runs", async () => {
		const approval = mock(
			(_request: ToolApprovalRequest, actions: ToolApprovalActions) => {
				queueMicrotask(() => actions.reject());
			}
		);
		await settleCallWith(
			{
				input: { command: "bun test" },
				toolCallId: "call-shell-reject",
				toolName: "shell",
			},
			{
				openApproval: approval,
				permissionRef: {
					current: createToolPermission({ shell: "ask" }),
				},
			}
		);
		expect(staticToolCallHandler).not.toHaveBeenCalled();
		expect(addToolOutput).toHaveBeenCalledWith({
			errorText: "Shell was not approved: bun test",
			state: "output-error",
			tool: "shell",
			toolCallId: "call-shell-reject",
		});
	});

	test("an always grant persists the exact command and skips only later siblings", async () => {
		const service = createPermissionService();
		const approval = mock(
			(_request: ToolApprovalRequest, actions: ToolApprovalActions) => {
				queueMicrotask(() => actions.allow(true));
			}
		);

		await settleCallWith(
			{
				input: { command: "bun test" },
				toolCallId: "call-shell-grant-1",
				toolName: "shell",
			},
			{
				openApproval: approval,
				permissionRef: {
					current: createToolPermission({ shell: { "*": "ask" } }),
				},
				service,
			}
		);
		expect(service.isGranted("shell", "bun test")).toBe(true);
		expect(service.isGranted("shell", "*")).toBe(false);

		await settleCallWith(
			{
				input: { command: "bun test" },
				toolCallId: "call-shell-grant-2",
				toolName: "shell",
			},
			{
				openApproval: approval,
				permissionRef: {
					current: createToolPermission({ shell: { "*": "ask" } }),
				},
				service,
			}
		);
		expect(approval).toHaveBeenCalledTimes(1);
		expect(staticToolCallHandler).toHaveBeenCalledTimes(2);
		expect(addToolOutput).not.toHaveBeenCalled();

		// A sibling command is not covered by the exact grant: it asks again.
		await settleCallWith(
			{
				input: { command: "git status" },
				toolCallId: "call-shell-grant-3",
				toolName: "shell",
			},
			{
				openApproval: approval,
				permissionRef: {
					current: createToolPermission({ shell: { "*": "ask" } }),
				},
				service,
			}
		);
		expect(approval).toHaveBeenCalledTimes(2);
		expect(staticToolCallHandler).toHaveBeenCalledTimes(3);
	});

	test("auto approval satisfies an ordinary shell ask without a dialog", async () => {
		await settleCallWith(
			{
				input: { command: "bun test" },
				toolCallId: "call-shell-auto",
				toolName: "shell",
			},
			{
				permissionRef: {
					current: createToolPermission({ shell: "ask" }),
				},
				service: createPermissionService({ autoApproval: true }),
			}
		);
		expect(openApproval).not.toHaveBeenCalled();
		expect(staticToolCallHandler).toHaveBeenCalledTimes(1);
	});

	test("rm and sudo are denied by default even under auto approval and grants", async () => {
		const service = createPermissionService({ autoApproval: true });
		service.grant("shell", "rm -rf /");
		const approval = mock(() => undefined);

		await settleCallWith(
			{
				input: { command: "rm -rf /" },
				toolCallId: "call-shell-destructive-deny",
				toolName: "shell",
			},
			{
				openApproval: approval,
				service,
			}
		);
		expect(approval).not.toHaveBeenCalled();
		expect(staticToolCallHandler).not.toHaveBeenCalled();
		expect(addToolOutput).toHaveBeenCalledWith({
			errorText: "Shell denied by policy: rm -rf /",
			state: "output-error",
			tool: "shell",
			toolCallId: "call-shell-destructive-deny",
		});
	});

	test("an external cwd composes the external-directory ask and grants the exact command", async () => {
		const dir = realpathSync(
			await mkdtemp(join(tmpdir(), "wincode-shell-external-"))
		);
		const requests: ToolApprovalRequest[] = [];
		const approval = mock(
			(request: ToolApprovalRequest, actions: ToolApprovalActions) => {
				requests.push(request);
				queueMicrotask(() => actions.allow(true));
			}
		);
		const service = createPermissionService();

		await settleCallWith(
			{
				input: { command: "pwd", cwd: "../shell-external-dir" },
				toolCallId: "call-shell-external",
				toolName: "shell",
			},
			{
				openApproval: approval,
				sandbox: createWorkspaceSandbox(dir),
				service,
			}
		);

		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			identity: [
				{ label: "tool", value: "shell" },
				{ label: "resource", value: "pwd" },
				{ label: "scope", value: "external" },
			],
		});
		// The always approval records the exact normalized command, not `shell *`.
		expect(service.isGranted("shell", "pwd")).toBe(true);
		expect(service.isGranted("shell", "*")).toBe(false);
		expect(
			service.isGranted(
				"external_directory",
				`${dirname(dir)}/shell-external-dir`
			)
		).toBe(true);
		expect(staticToolCallHandler).toHaveBeenCalledTimes(1);
	});

	test("a workspace-internal cwd gates without the external scope", async () => {
		const requests: ToolApprovalRequest[] = [];
		const approval = mock(
			(request: ToolApprovalRequest, actions: ToolApprovalActions) => {
				requests.push(request);
				queueMicrotask(() => actions.allow(false));
			}
		);

		await settleCallWith(
			{
				input: { command: "pwd", cwd: "apps/cli" },
				toolCallId: "call-shell-inside-cwd",
				toolName: "shell",
			},
			{
				openApproval: approval,
				permissionRef: {
					current: createToolPermission({ shell: "ask" }),
				},
			}
		);

		expect(requests).toHaveLength(1);
		const identity = requests[0]?.identity.map(({ label }) => label);
		expect(identity).toEqual(["tool", "resource"]);
		expect(staticToolCallHandler).toHaveBeenCalledTimes(1);
	});

	test("a home-directory cwd raises the external-directory boundary", async () => {
		const dir = realpathSync(
			await mkdtemp(join(tmpdir(), "wincode-shell-home-"))
		);
		const requests: ToolApprovalRequest[] = [];
		const approval = mock(
			(request: ToolApprovalRequest, actions: ToolApprovalActions) => {
				requests.push(request);
				queueMicrotask(() => actions.allow(false));
			}
		);

		await settleCallWith(
			{
				input: { command: "pwd", cwd: "~" },
				toolCallId: "call-shell-home-cwd",
				toolName: "shell",
			},
			{
				openApproval: approval,
				sandbox: createWorkspaceSandbox(dir),
			}
		);

		expect(requests).toHaveLength(1);
		const identity = requests[0]?.identity.map(({ label }) => label);
		expect(identity).toEqual(["tool", "resource", "scope"]);
		expect(requests[0]?.identity[2]).toEqual({
			label: "scope",
			value: "external",
		});
		expect(staticToolCallHandler).toHaveBeenCalledTimes(1);
	});

	test("a shell call without a command is left for the runner to validate", async () => {
		await settleCallWith(
			{
				input: {},
				toolCallId: "call-shell-no-command",
				toolName: "shell",
			},
			{}
		);
		expect(openApproval).not.toHaveBeenCalled();
		expect(staticToolCallHandler).toHaveBeenCalledTimes(1);
	});
});

describe("skill tool activation", () => {
	type ToolOutput = Parameters<
		ChatAddToolOutputFunction<CodingAgentUIMessage>
	>[0];
	type DynamicToolOutput = Parameters<McpAddToolOutput>[0];
	const addToolOutput = mock(
		(_config: ToolOutput | DynamicToolOutput) => undefined
	);
	const addToolOutputRef: {
		current: ChatAddToolOutputFunction<CodingAgentUIMessage> | null;
	} = { current: addToolOutput };
	const dynamicToolOutputRef: { current: McpAddToolOutput | null } = {
		current: addToolOutput,
	};
	const staticToolCallHandler = mock(() => undefined);
	const openApproval = mock(() => undefined);
	const sandbox = createWorkspaceSandbox(process.cwd());

	const makeSkill = (name: string, body: string) => ({
		body,
		description: `Description of ${name}`,
		filePath: `/skills/${name}/SKILL.md`,
		name,
		scope: "project" as const,
	});

	const makeExecution = (
		skills: ReturnType<typeof makeSkill>[],
		decision: (name: string) => PermissionDecision = () => "allow"
	) => {
		const catalog = buildSkillCatalog(skills, decision);
		return createSkillExecution(catalog);
	};

	const makeHandler = (
		execution: SkillExecution,
		overrides: Partial<Parameters<typeof createChatToolCallHandler>[0]> = {}
	) =>
		createChatToolCallHandler({
			addToolOutputRef,
			dynamicToolOutputRef,
			approvalQueue: createApprovalQueue<ToolApprovalRequest>(),
			handleCodingAgentToolCall: (() =>
				staticToolCallHandler) as typeof handleCodingAgentToolCall,
			mcp: { handleDynamicToolCall: mock(() => undefined) },
			mcpSnapshotRef: { current: null },
			openApproval,
			permissionRef: { current: createToolPermission() },
			resolvedAgentRef: { current: undefined },
			sandbox,
			service: createPermissionService(),
			skillExecutionRef: { current: execution },
			...overrides,
		});

	const settleCall = async (handler: ReturnType<typeof makeHandler>) => {
		handler({
			toolCall: {
				dynamic: true,
				input: { name: "review" },
				toolCallId: "skill-call-1",
				toolName: "skill",
			},
		} as never);
		await new Promise((resolve) => setTimeout(resolve, 75));
	};

	afterEach(() => {
		addToolOutput.mockClear();
		openApproval.mockClear();
	});

	test("loads a Skill and emits the live body with metadata", async () => {
		const execution = makeExecution([makeSkill("review", "Review body")]);
		await settleCall(makeHandler(execution));
		expect(addToolOutput).toHaveBeenCalledWith({
			output: {
				baseDirectory: "/skills/review",
				body: "Review body",
				contentHash: hashSkillBody("Review body"),
				name: "review",
				resourcePaths: [],
				source: "agent",
				status: "loaded",
			},
			state: "output-available",
			tool: "skill",
			toolCallId: "skill-call-1",
		});
		expect(execution.activeSnapshots().map(({ name }) => name)).toEqual([
			"review",
		]);
	});

	test("a policy-denied Skill is rejected without a slot and cannot be retried", async () => {
		const execution = makeExecution(
			[makeSkill("review", "Review body")],
			() => "deny"
		);
		await settleCall(
			makeHandler(execution, {
				permissionRef: { current: createToolPermission({ skill: "deny" }) },
			})
		);
		expect(addToolOutput).toHaveBeenCalledWith({
			output: { name: "review", status: "rejected" },
			state: "output-available",
			tool: "skill",
			toolCallId: "skill-call-1",
		});
		expect(execution.activeSnapshots()).toHaveLength(0);
		// A second attempt is short-circuited by the rejected set.
		await settleCall(
			makeHandler(execution, {
				permissionRef: { current: createToolPermission({ skill: "deny" }) },
			})
		);
		expect(addToolOutput).toHaveBeenCalledTimes(2);
	});

	test("an ask Skill runs after interactive approval", async () => {
		const requests: ToolApprovalRequest[] = [];
		const approval = mock((request: ToolApprovalRequest, actions) => {
			requests.push(request);
			queueMicrotask(() => actions.allow(false));
		});
		const execution = makeExecution(
			[makeSkill("review", "Review body")],
			() => "ask"
		);
		const handler = makeHandler(execution, {
			openApproval: approval,
			permissionRef: { current: createToolPermission({ skill: "ask" }) },
		});
		await settleCall(handler);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			description: "Description of review",
			identity: [
				{ label: "tool", value: "skill" },
				{ label: "skill", value: "review" },
			],
		});
		expect(addToolOutput).toHaveBeenCalledWith(
			expect.objectContaining({
				output: expect.objectContaining({ name: "review", status: "loaded" }),
			})
		);
	});

	test("a rejected ask marks the Skill rejected and consumes no slot", async () => {
		const execution = makeExecution(
			[makeSkill("review", "Review body")],
			() => "ask"
		);
		const approval = mock((_request: ToolApprovalRequest, actions) => {
			queueMicrotask(() => actions.reject());
		});
		await settleCall(
			makeHandler(execution, {
				openApproval: approval,
				permissionRef: { current: createToolPermission({ skill: "ask" }) },
			})
		);
		expect(addToolOutput).toHaveBeenCalledWith({
			output: { name: "review", status: "rejected" },
			state: "output-available",
			tool: "skill",
			toolCallId: "skill-call-1",
		});
		expect(execution.activeSnapshots()).toHaveLength(0);
		expect(execution.activate("review", "agent").status).toBe("rejected");
	});

	test("re-loading an active Skill is idempotent without a slot", async () => {
		const execution = makeExecution([makeSkill("review", "Review body")]);
		await settleCall(makeHandler(execution));
		await settleCall(makeHandler(execution));
		expect(addToolOutput).toHaveBeenCalledTimes(2);
		expect(addToolOutput).toHaveBeenLastCalledWith({
			output: {
				contentHash: hashSkillBody("Review body"),
				name: "review",
				status: "already-loaded",
			},
			state: "output-available",
			tool: "skill",
			toolCallId: "skill-call-1",
		});
		expect(execution.activeSnapshots()).toHaveLength(1);
	});

	test("a fourth distinct Skill reports the limit without replacing active Skills", async () => {
		const execution = makeExecution([
			makeSkill("a", "a"),
			makeSkill("b", "b"),
			makeSkill("c", "c"),
			makeSkill("d", "d"),
		]);
		const callSkill = async (name: string) => {
			const handler = makeHandler(execution);
			handler({
				toolCall: {
					dynamic: true,
					input: { name },
					toolCallId: `skill-call-${name}`,
					toolName: "skill",
				},
			} as never);
			await new Promise((resolve) => setTimeout(resolve, 75));
		};
		await callSkill("a");
		// Activate two more Skills directly, then load the fourth through the tool.
		execution.activate("b", "agent");
		execution.activate("c", "agent");
		addToolOutput.mockClear();
		await callSkill("d");
		expect(addToolOutput).toHaveBeenCalledWith({
			output: {
				activeSkillNames: ["a", "b", "c"],
				limit: 3,
				name: "d",
				status: "limit-reached",
			},
			state: "output-available",
			tool: "skill",
			toolCallId: "skill-call-d",
		});
	});

	test("an unknown Skill fails without consuming a slot", async () => {
		const execution = makeExecution([makeSkill("review", "Review body")]);
		const handler = makeHandler(execution);
		handler({
			toolCall: {
				dynamic: true,
				input: { name: "missing" },
				toolCallId: "skill-call-2",
				toolName: "skill",
			},
		} as never);
		await new Promise((resolve) => setTimeout(resolve, 75));
		expect(addToolOutput).toHaveBeenCalledWith({
			output: {
				error: 'Unknown Skill "missing"',
				name: "missing",
				status: "failed",
			},
			state: "output-available",
			tool: "skill",
			toolCallId: "skill-call-2",
		});
		expect(execution.activeSnapshots()).toHaveLength(0);
	});

	test("invalid tool input fails without touching the catalog", async () => {
		const execution = makeExecution([makeSkill("review", "Review body")]);
		const handler = makeHandler(execution);
		handler({
			toolCall: {
				dynamic: true,
				input: { nane: "review" },
				toolCallId: "skill-call-3",
				toolName: "skill",
			},
		} as never);
		await new Promise((resolve) => setTimeout(resolve, 75));
		expect(addToolOutput).toHaveBeenCalledWith({
			output: {
				error: "Invalid skill input; expected { name }",
				name: "",
				status: "failed",
			},
			state: "output-available",
			tool: "skill",
			toolCallId: "skill-call-3",
		});
	});

	test("sanitizeSkillToolParts strips bodies from finished turns", () => {
		const messages = [
			{
				id: "a1",
				parts: [
					{
						output: {
							baseDirectory: "/skills/review",
							body: "Review body",
							contentHash: "hash-1",
							name: "review",
							resourcePaths: ["/skills/review/a.txt"],
							source: "agent",
							status: "loaded",
						},
						state: "output-available",
						toolCallId: "skill-call-1",
						toolName: "skill",
						type: "dynamic-tool",
					},
				],
				role: "assistant",
			},
		] as unknown as CodingAgentUIMessage[];
		const sanitized = sanitizeSkillToolParts(messages);
		expect(sanitized[0]?.parts).toEqual([
			{
				input: undefined,
				output: {
					contentHash: "hash-1",
					name: "review",
					source: "agent",
					status: "loaded",
				},
				state: "output-available",
				toolCallId: "skill-call-1",
				toolName: "skill",
				type: "dynamic-tool",
			},
		]);
		expect(JSON.stringify(sanitized)).not.toContain("Review body");
		expect(JSON.stringify(sanitized)).not.toContain("skills/review");
	});

	test("sanitizeSkillToolParts leaves failed parts as output errors", () => {
		const messages = [
			{
				id: "a2",
				parts: [
					{
						output: { error: "boom", name: "x", status: "failed" },
						state: "output-available",
						toolCallId: "skill-call-4",
						toolName: "skill",
						type: "dynamic-tool",
					},
				],
				role: "assistant",
			},
		] as unknown as CodingAgentUIMessage[];
		const sanitized = sanitizeSkillToolParts(messages);
		expect(sanitized[0]?.parts).toEqual([
			{
				errorText: "boom",
				state: "output-error",
				toolCallId: "skill-call-4",
				toolName: "skill",
				type: "dynamic-tool",
			} as CodingAgentUIMessage["parts"][number],
		]);
	});
});

describe("activateExplicitSkill", () => {
	const makeSkill = (name: string, body: string) => ({
		body,
		description: `Description of ${name}`,
		filePath: `/skills/${name}/SKILL.md`,
		name,
		scope: "project" as const,
	});

	const makeExecution = (
		skills: ReturnType<typeof makeSkill>[],
		decision: (name: string) => PermissionDecision = () => "allow"
	) => createSkillExecution(buildSkillCatalog(skills, decision));

	const deps = (
		execution: SkillExecution,
		permission = createToolPermission(),
		openApproval: ToolPermissionRuntime["openApproval"] = () => undefined
	) => ({
		execution,
		gate: createToolGate({
			approvalQueue: createApprovalQueue<ToolApprovalRequest>(),
			openApproval,
			resolvePermission: async () => permission,
			sandbox: createWorkspaceSandbox(import.meta.dir),
			service: createPermissionService(),
		}),
		permission,
	});

	test("activates an allowed explicit Skill and returns the request payload", async () => {
		const execution = makeExecution([makeSkill("review", "Review body")]);
		const result = await activateExplicitSkill(
			{
				arguments: "focus on auth",
				instructions: "Review body",
				name: "review",
			},
			deps(execution)
		);
		expect(result).toEqual({
			ok: true,
			skill: {
				arguments: "focus on auth",
				contentHash: hashSkillBody("Review body"),
				instructions: "Review body",
				name: "review",
				source: "explicit",
			},
		});
		expect(execution.activeSnapshots().map(({ name }) => name)).toEqual([
			"review",
		]);
	});

	test("rejects denied explicit Skills without sending and marks them rejected", async () => {
		const execution = makeExecution(
			[makeSkill("review", "Review body")],
			() => "deny"
		);
		const result = await activateExplicitSkill(
			{ arguments: "", instructions: "Review body", name: "review" },
			deps(execution, createToolPermission({ skill: "deny" }))
		);
		expect(result).toEqual({
			ok: false,
			reason: 'Skill "review" is denied by policy',
		});
		expect(execution.activeSnapshots()).toHaveLength(0);
		expect(execution.activate("review", "agent").status).toBe("rejected");
	});

	test("asks and approves an ask-gated explicit Skill", async () => {
		const execution = makeExecution([makeSkill("review", "Review body")]);
		const requests: ToolApprovalRequest[] = [];
		const approval = mock(
			(
				request: ToolApprovalRequest,
				actions: { allow: (remember: boolean) => void }
			) => {
				requests.push(request);
				queueMicrotask(() => actions.allow(false));
			}
		);
		const result = await activateExplicitSkill(
			{ arguments: "", instructions: "Review body", name: "review" },
			deps(execution, createToolPermission({ skill: "ask" }), approval)
		);
		expect(result.ok).toBe(true);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.identity).toEqual([
			{ label: "tool", value: "skill" },
			{ label: "skill", value: "review" },
		]);
	});

	test("rejects on user disapproval and preserves nothing for the prompt", async () => {
		const execution = makeExecution([makeSkill("review", "Review body")]);
		const approval = mock(
			(_request: ToolApprovalRequest, actions: { reject: () => void }) => {
				queueMicrotask(() => actions.reject());
			}
		);
		const result = await activateExplicitSkill(
			{ arguments: "", instructions: "Review body", name: "review" },
			deps(execution, createToolPermission({ skill: "ask" }), approval)
		);
		expect(result).toEqual({
			ok: false,
			reason: 'Skill "review" was not approved',
		});
		expect(execution.activeSnapshots()).toHaveLength(0);
	});

	test("fails unknown Skills before any approval", async () => {
		const execution = makeExecution([makeSkill("review", "Review body")]);
		const result = await activateExplicitSkill(
			{ arguments: "", instructions: "x", name: "missing" },
			deps(execution)
		);
		expect(result).toEqual({
			ok: false,
			reason: 'Unknown or unavailable Skill "missing"',
		});
		expect(execution.activeSnapshots()).toHaveLength(0);
	});
});
