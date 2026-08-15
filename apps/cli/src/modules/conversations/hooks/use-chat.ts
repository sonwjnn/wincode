import { useChat as useAiChat } from "@ai-sdk/react";
import {
	type AgentId,
	buildAgent,
	type ChatModelSelection,
	type CodingAgentUIMessage,
	type CodingToolName,
	codingMessageSkillSchema,
	codingToolDefinitions,
	codingToolNames,
	defaultChatModelSelection,
	getChatModelRoute,
	type ModelVariant,
	type ResolvedAgentRuntime,
	type SkillContext,
	type SkillRequestContext,
	type SkillToolDefinition,
	skillToolInputSchema,
} from "@wincode/ai";
import {
	createUserMessage,
	handleCodingAgentToolCall,
} from "@wincode/ai/client";
import type { WorkspacePolicy } from "@wincode/ai/workspace";
import {
	type ChatAddToolOutputFunction,
	type ChatOnToolCallCallback,
	type FileUIPart,
	lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useMemo, useRef, useState } from "react";
import { useConnections } from "@/modules/connections";
import { resolveFileMentionParts } from "@/modules/file-mentions";
import {
	MCP_PERMISSION_RESOURCE,
	type McpAddToolOutput,
	type McpApprovalDecision,
	type McpApprovalGate,
	type McpCatalogSnapshot,
	type McpContextValue,
	type McpSnapshotTool,
	useMcp,
} from "@/modules/mcp";
import {
	canonicalizeExternalPath,
	canonicalizeResource,
	composePermissionDecisions,
	DESTRUCTIVE_SHELL_SAFETY_MESSAGE,
	expandHomeInPath,
	externalParentDirectoryGlob,
	isDestructiveShellCommand,
	type PermissionAction,
	type PermissionDecision,
	type PermissionService,
	resolveApproval,
	STATIC_TOOL_PERMISSION_ACTIONS,
	type ToolPermission,
	type ToolPermissionRuntime,
	useToolPermission,
} from "@/modules/permissions";
import {
	buildSkillToolDefinition,
	createSkillExecution,
	discoverSkillCatalog,
	isSkillToolPart,
	type SkillActivationResult,
	type SkillCatalog,
	type SkillExecution,
	type SkillToolResult,
	sampleSkillResources,
	sanitizeSkillToolPart,
} from "@/modules/skills";
import { useConfig } from "@/shared/config/config-provider";
import {
	type ApprovalQueue,
	createApprovalQueue,
} from "@/shared/providers/approval/approval-queue";
import { formatRejectionFeedback } from "@/shared/providers/approval/format";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import { getConversationStore } from "../storage/get-conversation-store";
import { createSkillSnapshot } from "../utils";
import { createRoutingChatTransport } from "./routing-chat-transport";

type SubmitChatParams = {
	agent: AgentId;
	conversationModel: ChatModelSelection;
	conversationVariant?: ModelVariant;
	model: ChatModelSelection;
	variant?: ModelVariant;
	resolvedAgent?: ResolvedAgentRuntime;
	userText: string;
	files?: FileUIPart[];
	skill?: SkillContext;
};

/**
 * The settled outcome of submitting a chat prompt. Explicit Skill rejection
 * resolves with `{ rejected: true }` so the caller can preserve the input and
 * attachments without sending a prompt.
 */
export type SubmitChatOutcome =
	| { readonly rejected: false }
	| { readonly rejected: true; readonly reason: string };

type MutableRefObject<T> = { current: T };

export type ChatToolCallHandlerDeps = {
	addToolOutputRef: MutableRefObject<ChatAddToolOutputFunction<CodingAgentUIMessage> | null>;
	approvalQueue: ApprovalQueue<ToolApprovalRequest>;
	handleCodingAgentToolCall?: typeof handleCodingAgentToolCall;
	mcp: Pick<McpContextValue, "handleDynamicToolCall">;
	mcpSnapshotRef: MutableRefObject<McpCatalogSnapshot | null>;
	openApproval: ToolPermissionRuntime["openApproval"];
	permissionRef: MutableRefObject<ToolPermission>;
	resolvedAgentRef: MutableRefObject<ResolvedAgentRuntime | undefined>;
	resolvePermission?: ToolPermissionRuntime["resolvePermission"];
	sandbox: WorkspacePolicy;
	service: PermissionService;
	skillExecutionRef?: MutableRefObject<SkillExecution | null>;
};

const STATIC_TOOL_LABELS = {
	read: "Read",
	write: "Write",
	edit: "Edit",
	list: "List",
	grep: "Grep",
	shell: "Shell",
} as const satisfies Record<CodingToolName, string>;

// The workspace-relative POSIX resource that `list` gates against when no path
// is supplied and the sandbox canonicalizes the workspace root to an empty path.
const WORKSPACE_ROOT_RESOURCE = ".";

// Shell always-approvals persist a process-scoped `shell *` grant: any later
// command for the action is satisfied unless the policy or safety ceiling asks.
const SHELL_GRANT_RESOURCE = "*";

const isCodingToolName = (name: string): name is CodingToolName =>
	(codingToolNames as readonly string[]).includes(name);

const getStringField = (input: unknown, field: string): string | undefined => {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return;
	}
	const candidate = (input as Record<string, unknown>)[field];
	return typeof candidate === "string" ? candidate : undefined;
};

type GateResource =
	| { kind: "path"; input: string; pattern?: string }
	| { kind: "literal"; value: string };

/**
 * Resolves the Permission resource for a static coding tool call. Read, write,
 * edit, and list gate against a filesystem path (list defaults to the workspace
 * root); grep gates against its requested regular expression verbatim, and its
 * optional path is carried for the external-directory boundary. A tool call
 * missing its required input is left ungated so the runner reports the
 * validation error.
 */
const resolveGateResource = (
	tool: CodingToolName,
	input: unknown
): GateResource | undefined => {
	if (tool === "grep") {
		const pattern = getStringField(input, "pattern");
		if (!pattern) {
			return;
		}
		const path = getStringField(input, "path");
		return path === undefined
			? { kind: "literal", value: pattern }
			: { input: path, kind: "path", pattern };
	}
	if (tool === "list") {
		return {
			input: getStringField(input, "path") ?? WORKSPACE_ROOT_RESOURCE,
			kind: "path",
		};
	}
	const path = getStringField(input, "path");
	return path === undefined ? undefined : { input: path, kind: "path" };
};

const emitToolCallError = (
	addToolOutput: ChatAddToolOutputFunction<CodingAgentUIMessage>,
	tool: CodingToolName,
	toolCallId: string,
	errorText: string
): void => {
	// Policy errors are emitted without awaiting, mirroring the tool-call
	// dispatch below: awaiting chat tool output here would deadlock the chat
	// executor at input-available.
	Promise.resolve(
		addToolOutput({
			errorText,
			state: "output-error",
			tool,
			toolCallId,
		})
	).catch(() => undefined);
};

/**
 * Enforces the Tool Permission policy for a static coding tool call. The tool's
 * actual resource is normalized immediately before execution — path resources
 * are canonicalized through the workspace sandbox, grep uses its regex — and the
 * governing action (`edit` covers both write and edit) is evaluated. A `deny`
 * decision or a rejected/cancelled `ask` decision settles the call with an
 * observable tool error without invoking the static tool runner. An allowed or
 * approved call runs the runner.
 */
type StaticToolGateDeps = {
	addToolOutput: ChatAddToolOutputFunction<CodingAgentUIMessage>;
	approvalQueue: ApprovalQueue<ToolApprovalRequest>;
	openApproval: ToolPermissionRuntime["openApproval"];
	permission: ToolPermission;
	sandbox: WorkspacePolicy;
	service: PermissionService;
};

/**
 * The settled outcome of gating one tool call through the shared Permission
 * engine and approval machinery: `deny` blocked it by policy, `reject` means the
 * user declined an ask (carrying any bounded correction feedback), and `allow`
 * clears it to run. Callers map this onto their own emit/return shape.
 */
type ToolApprovalGateResult =
	| { kind: "allow" }
	| { kind: "deny" }
	| { kind: "reject"; feedback?: string };

type ResolveToolApprovalDeps = {
	action: string;
	approvalQueue: ApprovalQueue<ToolApprovalRequest>;
	decision: PermissionDecision;
	openApproval: ToolPermissionRuntime["openApproval"];
	request: ToolApprovalRequest;
	resource: string;
	safety: boolean;
	service: PermissionService;
};

/**
 * The single approval path shared by static coding tools and dynamic MCP tools.
 * It applies temporary grants and auto approval to the raw policy `decision`
 * (`resolveApproval`), and for an `ask` enqueues the request on the conversation
 * approval queue, opens the shared inline approval panel, awaits the outcome,
 * records an "always" grant against the exact `(action, resource)` key, and
 * surfaces reject feedback. Both tool families resolve through this one function
 * so their once/always/reject/auto behaviour can never drift apart.
 */
const resolveToolApproval = async ({
	action,
	approvalQueue,
	decision,
	openApproval,
	request,
	resource,
	safety,
	service,
}: ResolveToolApprovalDeps): Promise<ToolApprovalGateResult> => {
	const effective = resolveApproval({
		action,
		decision,
		isAutoApproval: () => service.isAutoApproval(),
		isGranted: (grantedAction, grantedResource) =>
			service.isGranted(grantedAction, grantedResource),
		resource,
		safety,
	});
	if (effective === "deny") {
		return { kind: "deny" };
	}
	if (effective === "allow") {
		return { kind: "allow" };
	}
	const handle = approvalQueue.request(request);
	openApproval(request, {
		allow: (remember) => handle.allow(remember),
		cancel: () => handle.rejectSelf(),
		reject: (feedback) => approvalQueue.rejectAll(feedback),
	});
	const outcome = await handle.outcome;
	if (outcome.decision === "reject") {
		return {
			feedback: formatRejectionFeedback(outcome.feedback),
			kind: "reject",
		};
	}
	if (outcome.remember) {
		service.grant(action, resource);
	}
	return { kind: "allow" };
};

/**
 * The approval flow for a path outside the workspace. The composed decision
 * folds the operation policy (`read`, `edit`, ...) with the `external_directory`
 * boundary so neither source can loosen the other. An "always" outcome grants
 * the canonical parent-directory glob for `external_directory` and the exact
 * canonical path for the operation, so approval scope stays bounded and
 * revocable. `grantResource` overrides the operation grant key (shell always
 * grants the process-scoped `*` resource instead of the external path).
 */
const resolveExternalDirectoryApproval = async ({
	action,
	approvalQueue,
	decision,
	openApproval,
	request,
	resource,
	grantResource = resource,
	safety,
	service,
}: {
	action: string;
	approvalQueue: ApprovalQueue<ToolApprovalRequest>;
	decision: PermissionDecision;
	openApproval: ToolPermissionRuntime["openApproval"];
	request: ToolApprovalRequest;
	resource: string;
	grantResource?: string;
	safety: boolean;
	service: PermissionService;
}): Promise<ToolApprovalGateResult> => {
	const effective = resolveApproval({
		action: "external_directory",
		decision,
		isAutoApproval: () => service.isAutoApproval(),
		isGranted: (grantedAction, grantedResource) =>
			service.isGranted(grantedAction, grantedResource),
		resource,
		safety,
	});
	if (effective === "deny") {
		return { kind: "deny" };
	}
	if (effective === "allow") {
		return { kind: "allow" };
	}
	const handle = approvalQueue.request(request);
	openApproval(request, {
		allow: (remember) => handle.allow(remember),
		cancel: () => handle.rejectSelf(),
		reject: (feedback) => approvalQueue.rejectAll(feedback),
	});
	const outcome = await handle.outcome;
	if (outcome.decision === "reject") {
		return {
			feedback: formatRejectionFeedback(outcome.feedback),
			kind: "reject",
		};
	}
	if (outcome.remember) {
		service.grant("external_directory", externalParentDirectoryGlob(resource));
		service.grant(action, grantResource);
	}
	return { kind: "allow" };
};

const gateStaticToolCall = async (
	options: Parameters<ChatOnToolCallCallback<CodingAgentUIMessage>>[0],
	{
		addToolOutput,
		approvalQueue,
		openApproval,
		permission,
		sandbox,
		service,
	}: StaticToolGateDeps
): Promise<boolean> => {
	const toolCall = options.toolCall;
	if (!isCodingToolName(toolCall.toolName)) {
		return true;
	}
	const tool = toolCall.toolName;
	const gate = resolveGateResource(tool, toolCall.input);
	if (gate === undefined) {
		return true;
	}
	const label = STATIC_TOOL_LABELS[tool];
	const action = STATIC_TOOL_PERMISSION_ACTIONS[tool];

	if (gate.kind === "literal") {
		return gateByDecision(
			options,
			{ action, label, permission, resource: gate.value },
			{ addToolOutput, approvalQueue, openApproval, service }
		);
	}

	try {
		const canonical = await canonicalizeResource(gate.input, sandbox);
		// Grep gates its operation against the regex; its path only decides the
		// external boundary. Other path tools gate against the canonical path.
		const resource =
			gate.pattern ?? (canonical === "" ? WORKSPACE_ROOT_RESOURCE : canonical);
		return gateByDecision(
			options,
			{ action, label, permission, resource },
			{ addToolOutput, approvalQueue, openApproval, service }
		);
	} catch {
		// The path is outside the workspace: the external_directory boundary
		// applies in addition to the operation policy.
		return gateExternalPath(
			options,
			{ action, label, operationResource: gate.pattern, permission, sandbox },
			{ addToolOutput, approvalQueue, openApproval, service }
		);
	}
};

type GateDecisionDeps = {
	addToolOutput: ChatAddToolOutputFunction<CodingAgentUIMessage>;
	approvalQueue: ApprovalQueue<ToolApprovalRequest>;
	openApproval: ToolPermissionRuntime["openApproval"];
	service: PermissionService;
};

type GatePermissionContext = {
	action: PermissionAction;
	label: string;
	permission: ToolPermission;
	resource: string;
};

const gateByDecision = async (
	options: Parameters<ChatOnToolCallCallback<CodingAgentUIMessage>>[0],
	{ action, label, permission, resource }: GatePermissionContext,
	deps: GateDecisionDeps
): Promise<boolean> => {
	const { addToolOutput, approvalQueue, openApproval, service } = deps;
	const tool = options.toolCall.toolName as CodingToolName;
	const request: ToolApprovalRequest = {
		description: codingToolDefinitions[tool].description,
		identity: [
			{ label: "tool", value: tool },
			{ label: "resource", value: resource },
		],
		input: options.toolCall.input,
		safety: permission.safety,
		toolCallId: options.toolCall.toolCallId,
	};
	const result = await resolveToolApproval({
		action,
		approvalQueue,
		decision: permission.decide(action, resource),
		openApproval,
		request,
		resource,
		safety: permission.safety,
		service,
	});

	return emitGateOutcome(
		addToolOutput,
		tool,
		options.toolCall.toolCallId,
		label,
		resource,
		result
	);
};

/**
 * Maps one settled gate outcome onto the conversation: policy denies and
 * rejections emit an observable tool error, an allow clears the call to run.
 * Every static-tool gate settles through this one helper so their deny and
 * reject semantics never drift apart.
 */
const emitGateOutcome = (
	addToolOutput: ChatAddToolOutputFunction<CodingAgentUIMessage>,
	tool: CodingToolName,
	toolCallId: string,
	label: string,
	resource: string,
	result: ToolApprovalGateResult
): boolean => {
	if (result.kind === "deny") {
		emitToolCallError(
			addToolOutput,
			tool,
			toolCallId,
			`${label} denied by policy: ${resource}`
		);
		return false;
	}
	if (result.kind === "reject") {
		emitToolCallError(
			addToolOutput,
			tool,
			toolCallId,
			result.feedback === undefined
				? `${label} was not approved: ${resource}`
				: `${label} was not approved: ${resource} — ${result.feedback}`
		);
		return false;
	}
	return true;
};

const gateExternalPath = async (
	options: Parameters<ChatOnToolCallCallback<CodingAgentUIMessage>>[0],
	{
		action,
		label,
		operationResource,
		permission,
		sandbox,
	}: {
		action: PermissionAction;
		label: string;
		operationResource?: string;
		permission: ToolPermission;
		sandbox: WorkspacePolicy;
	},
	deps: GateDecisionDeps
): Promise<boolean> => {
	const { addToolOutput, approvalQueue, openApproval, service } = deps;
	const tool = options.toolCall.toolName as CodingToolName;
	const inputRecord =
		typeof options.toolCall.input === "object" &&
		options.toolCall.input !== null &&
		!Array.isArray(options.toolCall.input)
			? (options.toolCall.input as Record<string, unknown>)
			: {};
	const pathInput =
		typeof inputRecord.path === "string" ? inputRecord.path : "";
	let resource: string;
	try {
		resource = await canonicalizeExternalPath(pathInput, sandbox.root);
	} catch {
		emitToolCallError(
			addToolOutput,
			tool,
			options.toolCall.toolCallId,
			`${label} path is outside the workspace: ${pathInput}`
		);
		return false;
	}

	// The operation keeps its own resource (the regex for grep, the canonical
	// path otherwise); external_directory adds a boundary on top of it.
	const decision = composePermissionDecisions(
		permission.decide(action, operationResource ?? resource),
		permission.decide("external_directory", resource)
	);
	const request: ToolApprovalRequest = {
		description: codingToolDefinitions[tool].description,
		identity: [
			{ label: "tool", value: tool },
			{ label: "resource", value: resource },
			{ label: "scope", value: "external" },
		],
		input: options.toolCall.input,
		safety: permission.safety,
		toolCallId: options.toolCall.toolCallId,
	};
	const result = await resolveExternalDirectoryApproval({
		action,
		approvalQueue,
		decision,
		openApproval,
		request,
		resource,
		safety: permission.safety,
		service,
	});

	return emitGateOutcome(
		addToolOutput,
		tool,
		options.toolCall.toolCallId,
		label,
		resource,
		result
	);
};

/**
 * Enforces the Tool Permission policy for a `shell` tool call. The command is
 * the evaluated resource; a workspace-internal `cwd` runs directly, while a
 * `cwd` outside the workspace composes the `external_directory` boundary
 * (canonicalized and symlink-resolved like file tools). Always approvals
 * persist a process-scoped `shell *` grant. Destructive commands raise the
 * safety ceiling on top of the policy: they always prompt, and neither
 * `--auto`, a remembered grant, nor a permissive configured rule can run them
 * without a fresh approval.
 */
const gateShellToolCall = async (
	options: Parameters<ChatOnToolCallCallback<CodingAgentUIMessage>>[0],
	{
		addToolOutput,
		approvalQueue,
		openApproval,
		permission,
		sandbox,
		service,
	}: StaticToolGateDeps
): Promise<boolean> => {
	const toolCall = options.toolCall;
	const command = getStringField(toolCall.input, "command");
	if (!command) {
		// Missing command: left ungated so the runner reports the validation
		// error, mirroring the other static tools.
		return true;
	}
	const cwd = getStringField(toolCall.input, "cwd");
	const destructive = isDestructiveShellCommand(command);
	const request: ToolApprovalRequest = {
		description: codingToolDefinitions.shell.description,
		identity: [
			{ label: "tool", value: "shell" },
			{ label: "resource", value: command },
		],
		input: toolCall.input,
		safety: permission.safety || destructive,
		...(destructive ? { safetyReason: DESTRUCTIVE_SHELL_SAFETY_MESSAGE } : {}),
		toolCallId: toolCall.toolCallId,
	};
	const rawDecision = permission.decide("shell", command);
	// The classifier is a ceiling, not a bypass: an explicit policy deny still
	// denies, every other destructive command becomes a manual-only ask.
	const operationDecision =
		rawDecision === "deny" || !destructive ? rawDecision : "ask";
	const safety = permission.safety || destructive;

	let externalResource: string | undefined;
	if (cwd !== undefined) {
		// `~` and `$HOME` point outside the workspace, so they are expanded
		// before canonicalization exactly like the runner does; otherwise a
		// `cwd: "~"` would silently resolve inside the workspace at gate time
		// and run in the home directory after approval.
		const expandedCwd = expandHomeInPath(cwd);
		try {
			await canonicalizeResource(expandedCwd, sandbox);
		} catch {
			try {
				externalResource = await canonicalizeExternalPath(
					expandedCwd,
					sandbox.root
				);
			} catch {
				emitToolCallError(
					addToolOutput,
					"shell",
					toolCall.toolCallId,
					`Shell working directory is outside the workspace: ${cwd}`
				);
				return false;
			}
		}
	}

	const decision =
		externalResource === undefined
			? operationDecision
			: composePermissionDecisions(
					operationDecision,
					permission.decide("external_directory", externalResource)
				);
	const result =
		externalResource === undefined
			? await resolveToolApproval({
					action: "shell",
					approvalQueue,
					decision,
					openApproval,
					request,
					resource: SHELL_GRANT_RESOURCE,
					safety,
					service,
				})
			: await resolveExternalDirectoryApproval({
					action: "shell",
					approvalQueue,
					decision,
					grantResource: SHELL_GRANT_RESOURCE,
					openApproval,
					request: {
						...request,
						identity: [
							...request.identity,
							{ label: "scope", value: "external" },
						],
					},
					resource: externalResource,
					safety,
					service,
				});

	return emitGateOutcome(
		addToolOutput,
		"shell",
		toolCall.toolCallId,
		"Shell",
		command,
		result
	);
};

type McpApprovalGateDeps = {
	approvalQueue: ApprovalQueue<ToolApprovalRequest>;
	openApproval: ToolPermissionRuntime["openApproval"];
	service: PermissionService;
};

/**
 * Builds the shared-approval gate for one dynamic MCP tool call. It resolves
 * through the same {@link resolveToolApproval} helper as static coding tools —
 * one temporary-grant store, auto-approval flag, conversation approval queue,
 * and inline approval panel — keyed by the tool's logical name and the single
 * `*` resource. The composed decision already baked the Agent+server policy and
 * any safety ceiling into `tool.policy`/`tool.safety`, so grants and auto
 * approval may satisfy an ordinary ask, a safety ask always prompts, and an
 * explicit deny is never bypassed. An "always" outcome grants the exact logical
 * name.
 */
export const createMcpApprovalGate =
	({
		approvalQueue,
		openApproval,
		service,
	}: McpApprovalGateDeps): McpApprovalGate =>
	(
		tool: McpSnapshotTool,
		input: unknown,
		toolCallId: string
	): Promise<McpApprovalDecision> => {
		const request: ToolApprovalRequest = {
			description: tool.description,
			identity: [
				{ label: "tool", value: tool.logicalName },
				{ label: "resource", value: MCP_PERMISSION_RESOURCE },
			],
			input,
			safety: tool.safety,
			toolCallId,
		};
		// The composed decision already folded the Agent+server policy and any
		// safety ceiling into tool.policy/tool.safety, so the shared resolver
		// applies grants/auto/ask exactly as it does for a static coding tool. Its
		// `ToolApprovalGateResult` is a subset of `McpApprovalDecision`.
		return resolveToolApproval({
			action: tool.logicalName,
			approvalQueue,
			decision: tool.policy,
			openApproval,
			request,
			resource: MCP_PERMISSION_RESOURCE,
			safety: tool.safety,
			service,
		});
	};

/**
 * Dispatches AI SDK tool calls to the MCP handler for dynamic tools, to the
 * Skill Activation runner for the native `skill` tool, and to the coding-agent
 * handler otherwise. The AI SDK awaits `onToolCall`, but `addToolOutput`
 * queues on the same chat executor, so neither promise is returned or awaited
 * here or tool execution deadlocks at input-available.
 */
export const createChatToolCallHandler =
	({
		addToolOutputRef,
		approvalQueue,
		handleCodingAgentToolCall: runStaticToolCall = handleCodingAgentToolCall,
		mcp,
		mcpSnapshotRef,
		openApproval,
		permissionRef,
		resolvedAgentRef,
		resolvePermission,
		sandbox,
		service,
		skillExecutionRef,
	}: ChatToolCallHandlerDeps): ChatOnToolCallCallback<CodingAgentUIMessage> =>
	(options) => {
		const addToolOutput = addToolOutputRef.current;

		if (!addToolOutput) {
			return;
		}

		if (options.toolCall.toolName === "skill") {
			// The `skill` tool is declared as a dynamic tool on the model loop but
			// executed entirely in the CLI, so it is intercepted before the MCP
			// dispatch below.
			const skillAddToolOutput = addToolOutput as unknown as McpAddToolOutput;
			Promise.resolve(
				(async () => {
					const permission = resolvePermission
						? await resolvePermission()
						: permissionRef.current;
					await runSkillToolCall({
						addToolOutput: skillAddToolOutput,
						approvalQueue,
						executionRef: skillExecutionRef,
						openApproval,
						permission,
						service,
						toolCall: options.toolCall as Parameters<
							typeof runSkillToolCall
						>[0]["toolCall"],
					});
				})()
			).catch(() => undefined);
			return;
		}

		if (options.toolCall.dynamic) {
			// The AI SDK types addToolOutput for static coding tools, but dynamic
			// MCP tools carry arbitrary names; runtime matching is by toolCallId,
			// so bridge the type here.
			const mcpAddToolOutput = addToolOutput as unknown as McpAddToolOutput;
			Promise.resolve(
				mcp.handleDynamicToolCall(
					mcpSnapshotRef.current,
					options.toolCall,
					mcpAddToolOutput,
					createMcpApprovalGate({ approvalQueue, openApproval, service })
				)
			).catch(() => undefined);
			return;
		}

		if (options.toolCall.toolName === "shell") {
			// Shell is a static coding tool with its own gate: the command is the
			// evaluated resource, `cwd` composes the external-directory boundary,
			// and destructive commands raise the safety ceiling. It is intercepted
			// before the shared static gate because its inputs carry no path to
			// resolve and its always-approval grants `shell *`.
			Promise.resolve(
				(async () => {
					const permission = resolvePermission
						? await resolvePermission()
						: permissionRef.current;
					if (
						await gateShellToolCall(options, {
							addToolOutput,
							approvalQueue,
							openApproval,
							permission,
							sandbox,
							service,
						})
					) {
						await runStaticToolCall(
							addToolOutput,
							resolvedAgentRef.current?.visibleCodingTools ?? []
						)(options);
					}
				})()
			).catch(() => undefined);
			return;
		}

		Promise.resolve(
			(async () => {
				if (
					!(await gateStaticToolCall(options, {
						addToolOutput,
						approvalQueue,
						openApproval,
						permission: resolvePermission
							? await resolvePermission()
							: permissionRef.current,
						sandbox,
						service,
					}))
				) {
					return;
				}
				await runStaticToolCall(
					addToolOutput,
					resolvedAgentRef.current?.visibleCodingTools ?? []
				)(options);
			})()
		).catch(() => undefined);
	};

export type SkillToolCallDeps = {
	addToolOutput: McpAddToolOutput;
	approvalQueue: ApprovalQueue<ToolApprovalRequest>;
	executionRef?: MutableRefObject<SkillExecution | null>;
	openApproval: ToolPermissionRuntime["openApproval"];
	permission: ToolPermission;
	service: PermissionService;
	toolCall: { input?: unknown; toolCallId: string };
};

const emitSkillToolResult = (
	addToolOutput: McpAddToolOutput,
	toolCallId: string,
	result: SkillToolResult
): void | PromiseLike<void> =>
	addToolOutput({
		output: result,
		state: "output-available",
		tool: "skill",
		toolCallId,
	});

/**
 * Executes one Agent-driven `skill` tool call entirely in the CLI: the Skill is
 * looked up in the execution-turn catalog, its `skill` Permission decision is
 * evaluated (an `ask` goes through the shared approval dialog), and the body
 * snapshot is activated within the three-Skill limit. Rejected and failed
 * loads consume no slot, a rejected Skill cannot be retried in the same
 * execution, and the emitted result is the live payload for the model loop —
 * durable state sanitizes it separately.
 */
export const runSkillToolCall = async ({
	addToolOutput,
	approvalQueue,
	executionRef,
	openApproval,
	permission,
	service,
	toolCall,
}: SkillToolCallDeps): Promise<void> => {
	const execution = executionRef?.current ?? null;
	if (!execution) {
		await emitSkillToolResult(addToolOutput, toolCall.toolCallId, {
			error: "Skill Activation is not active for this turn",
			name: "",
			status: "failed",
		});
		return;
	}
	const input = skillToolInputSchema.safeParse(toolCall.input);
	if (!input.success) {
		await emitSkillToolResult(addToolOutput, toolCall.toolCallId, {
			error: "Invalid skill input; expected { name }",
			name: "",
			status: "failed",
		});
		return;
	}
	const name = input.data.name;

	// The policy is evaluated before the catalog lookup so a denied Skill —
	// hidden from the catalog by design — settles as rejected, not failed.
	const decision = permission.decide("skill", name);
	if (decision === "deny") {
		execution.markRejected(name);
		await emitSkillToolResult(addToolOutput, toolCall.toolCallId, {
			name,
			status: "rejected",
		});
		return;
	}

	const entry = execution.catalog.entries.find(
		({ name: entryName }) => entryName === name
	);
	if (!entry) {
		const result = execution.activate(name, "agent");
		await emitSkillToolResult(
			addToolOutput,
			toolCall.toolCallId,
			resultToToolResult(result)
		);
		return;
	}

	if (decision === "ask") {
		const outcome = await resolveToolApproval({
			action: "skill",
			approvalQueue,
			decision,
			openApproval,
			request: {
				description: entry.description,
				identity: [
					{ label: "tool", value: "skill" },
					{ label: "skill", value: name },
				],
				input: { name },
				safety: permission.safety,
				toolCallId: toolCall.toolCallId,
			},
			resource: name,
			safety: permission.safety,
			service,
		});
		if (outcome.kind !== "allow") {
			execution.markRejected(name);
			await emitSkillToolResult(addToolOutput, toolCall.toolCallId, {
				name,
				status: "rejected",
			});
			return;
		}
	}

	const result = execution.activate(name, "agent");
	if (result.status === "loaded") {
		const resourcePaths = await sampleSkillResources(
			result.snapshot.baseDirectory
		);
		execution.setResourceSample(name, resourcePaths);
		await emitSkillToolResult(addToolOutput, toolCall.toolCallId, {
			baseDirectory: result.snapshot.baseDirectory,
			body: result.snapshot.body,
			contentHash: result.snapshot.contentHash,
			name,
			resourcePaths,
			source: "agent",
			status: "loaded",
		});
		return;
	}
	await emitSkillToolResult(addToolOutput, toolCall.toolCallId, result);
};

const resultToToolResult = (result: SkillActivationResult): SkillToolResult => {
	if (result.status === "loaded") {
		return {
			baseDirectory: result.snapshot.baseDirectory,
			body: result.snapshot.body,
			contentHash: result.snapshot.contentHash,
			name: result.snapshot.name,
			resourcePaths: result.snapshot.resourcePaths,
			source: result.snapshot.source,
			status: "loaded",
		};
	}
	if (result.status === "already-loaded") {
		return {
			contentHash: result.contentHash,
			name: result.name,
			status: "already-loaded",
		};
	}
	if (result.status === "failed") {
		return { error: result.error, name: result.name, status: "failed" };
	}
	if (result.status === "limit-reached") {
		return {
			activeSkillNames: result.activeSkillNames,
			limit: result.limit,
			name: result.name,
			status: "limit-reached",
		};
	}
	return { name: result.name, status: "rejected" };
};

export const createChatMessageParts = (
	userText: string,
	fileMentions: CodingAgentUIMessage["parts"],
	files: FileUIPart[]
) => [{ text: userText, type: "text" as const }, ...fileMentions, ...files];

/**
 * Strips Skill bodies, base directories, and bundled resource paths from
 * `skill` tool parts so a finished turn's context never leaks into a later
 * execution. Loaded parts from the active turn keep their live payload; every
 * other part collapses to its sanitized activation metadata.
 */
export const sanitizeSkillToolParts = (
	messages: CodingAgentUIMessage[]
): CodingAgentUIMessage[] =>
	messages.map((message) => {
		if (!message.parts.some(isSkillToolPart)) {
			return message;
		}
		return {
			...message,
			parts: message.parts.map((part) =>
				isSkillToolPart(part) ? sanitizeSkillToolPart(part) : part
			),
		};
	});

export const notifyHostedCompletion = (
	model: ChatModelSelection,
	onHostedCompletion?: () => void
): void => {
	if (getChatModelRoute(model) === "hosted") {
		onHostedCompletion?.();
	}
};

export const findCurrentTurnAssistantIndex = (
	messages: CodingAgentUIMessage[]
): number => {
	const userIndex = messages.findLastIndex(({ role }) => role === "user");
	const assistantIndex = messages.findLastIndex(
		({ role }) => role === "assistant"
	);

	return assistantIndex > userIndex ? assistantIndex : -1;
};

export const findCurrentTurnInterruptTargetIndex = (
	messages: CodingAgentUIMessage[]
): number => {
	const assistantIndex = findCurrentTurnAssistantIndex(messages);
	if (assistantIndex !== -1) {
		return assistantIndex;
	}

	return messages.findLastIndex(({ role }) => role === "user");
};

export const getOriginatingUserMessageId = (
	messages: CodingAgentUIMessage[]
): string | undefined => messages.findLast(({ role }) => role === "user")?.id;

export const finalizeAssistantMessageMetadata = (
	message: CodingAgentUIMessage,
	context: {
		agent: AgentId;
		model: ChatModelSelection;
		variant?: ModelVariant;
		interrupted: boolean;
		responseTimeMs?: number;
	}
): CodingAgentUIMessage => ({
	...message,
	metadata: (() => {
		const metadata = message.metadata ?? {};
		const nextMetadata: CodingAgentUIMessage["metadata"] = {
			...metadata,
			agent: message.metadata?.agent ?? context.agent,
			interrupted: context.interrupted,
			model: message.metadata?.model ?? context.model,
		};

		if (message.metadata?.variant !== undefined) {
			nextMetadata.variant = message.metadata.variant;
		} else if (context.variant !== undefined) {
			nextMetadata.variant = context.variant;
		}

		if (context.responseTimeMs !== undefined) {
			nextMetadata.responseTimeMs = context.responseTimeMs;
		}

		return nextMetadata;
	})(),
});

export type ActivateExplicitSkillDeps = {
	approvalQueue: ApprovalQueue<ToolApprovalRequest>;
	execution: SkillExecution;
	openApproval: ToolPermissionRuntime["openApproval"];
	permission: ToolPermission;
	service: PermissionService;
};

/**
 * Resolves and authorizes an explicit `/skill-name arguments` submission
 * before the first model call. Rejection (policy, approval, or an unknown
 * Skill) preserves the input and sends nothing; acceptance consumes one
 * activation slot and returns the request-scoped Skill payload.
 */
export const activateExplicitSkill = async (
	skill: SkillContext,
	{
		approvalQueue,
		execution,
		openApproval,
		permission,
		service,
	}: ActivateExplicitSkillDeps
): Promise<
	{ ok: true; skill: SkillRequestContext } | { ok: false; reason: string }
> => {
	// The policy is evaluated before the catalog lookup so a denied Skill —
	// hidden from the catalog by design — settles as a policy rejection.
	const decision = permission.decide("skill", skill.name);
	if (decision === "deny") {
		execution.markRejected(skill.name);
		return { ok: false, reason: `Skill "${skill.name}" is denied by policy` };
	}
	const entry = execution.catalog.entries.find(
		({ name }) => name === skill.name
	);
	if (!entry) {
		return {
			ok: false,
			reason: `Unknown or unavailable Skill "${skill.name}"`,
		};
	}
	if (decision === "ask") {
		const outcome = await resolveToolApproval({
			action: "skill",
			approvalQueue,
			decision,
			openApproval,
			request: {
				description: entry.description,
				identity: [
					{ label: "tool", value: "skill" },
					{ label: "skill", value: entry.name },
				],
				input: { name: entry.name },
				safety: permission.safety,
			},
			resource: entry.name,
			safety: permission.safety,
			service,
		});
		if (outcome.kind !== "allow") {
			execution.markRejected(entry.name);
			return {
				ok: false,
				reason:
					outcome.kind === "deny"
						? `Skill "${entry.name}" is denied by policy`
						: `Skill "${entry.name}" was not approved`,
			};
		}
	}
	const result = execution.activate(entry.name, "explicit");
	if (result.status !== "loaded") {
		return {
			ok: false,
			reason: `Skill "${entry.name}" could not be activated`,
		};
	}
	return {
		ok: true,
		skill: {
			arguments: skill.arguments,
			contentHash: result.snapshot.contentHash,
			instructions: result.snapshot.body,
			name: entry.name,
			source: "explicit",
		},
	};
};

export function useChat(
	sessionId: string,
	initialMessages: CodingAgentUIMessage[],
	onHostedCompletion?: () => void
) {
	const connections = useConnections();
	const mcp = useMcp();
	const config = useConfig();
	const {
		openApproval,
		permissionRef,
		resolveMcpPolicy,
		resolvePermission,
		sandbox,
		service,
	} = useToolPermission();
	// The transport is memoized on a coarser dependency set than the Agent-scoped
	// policy resolver, so read the latest resolver through a ref to avoid building
	// a snapshot against a stale Agent's MCP policy.
	const resolveMcpPolicyRef = useRef(resolveMcpPolicy);
	resolveMcpPolicyRef.current = resolveMcpPolicy;
	// The approval queue is conversation-scoped: rejecting one request settles
	// every pending approval in this conversation without touching other
	// conversations' queues. Created once per conversation via lazy ref init.
	const approvalQueueRef = useRef<ApprovalQueue<ToolApprovalRequest> | null>(
		null
	);
	if (approvalQueueRef.current === null) {
		approvalQueueRef.current = createApprovalQueue<ToolApprovalRequest>();
	}
	const addToolOutputRef =
		useRef<ChatAddToolOutputFunction<CodingAgentUIMessage> | null>(null);
	const interruptedMessageIdsRef = useRef(new Set<string>());
	const requestStartedAtRef = useRef<number | null>(null);
	const setMessagesRef = useRef<
		((messages: CodingAgentUIMessage[]) => void) | undefined
	>(undefined);
	const agentRef = useRef<AgentId>(buildAgent.id);
	const resolvedAgentRef = useRef<ResolvedAgentRuntime | undefined>(undefined);
	const modelRef = useRef<ChatModelSelection>(defaultChatModelSelection);
	const conversationModelRef = useRef<ChatModelSelection>(
		defaultChatModelSelection
	);
	const conversationVariantRef = useRef<ModelVariant | undefined>(undefined);
	const variantRef = useRef<ModelVariant | undefined>(undefined);
	const mcpSnapshotRef = useRef<McpCatalogSnapshot | null>(null);
	// The execution-scoped Skill Activation state: one catalog snapshot and
	// activation context per user turn, replaced at every submit/continue.
	const skillExecutionRef = useRef<SkillExecution | null>(null);
	const skillToolRef = useRef<SkillToolDefinition | undefined>(undefined);
	const [isPreparingMessage, setIsPreparingMessage] = useState(false);
	const [catalogDiagnostic, setCatalogDiagnostic] = useState<string | null>(
		null
	);

	const transport = useMemo(() => {
		// The transport snapshots the MCP catalog once per send; mirror the same
		// immutable snapshot into a ref so dynamic tool dispatch resolves against
		// the exact catalog the request was built from.
		const mcpWithSnapshotRef: McpContextValue = {
			...mcp,
			createSnapshot: async (agent: AgentId) => {
				// Resolve the snapshot for the executing Agent's effective MCP policy
				// so deny composes out unavailable tools and ask/allow are visible.
				const agentPolicy = await resolveMcpPolicyRef.current();
				const snapshot = await mcp.createSnapshot(agent, agentPolicy);
				mcpSnapshotRef.current = snapshot;
				return snapshot;
			},
		};

		return createRoutingChatTransport(
			sessionId,
			agentRef,
			resolvedAgentRef,
			modelRef,
			variantRef,
			connections,
			mcpWithSnapshotRef,
			skillToolRef
		);
	}, [connections, mcp, sessionId]);

	const finalizeAssistantMessages = (messages: CodingAgentUIMessage[]) => {
		const startedAt = requestStartedAtRef.current;

		const responseTimeMs =
			startedAt === null ? undefined : Math.max(0, Date.now() - startedAt);
		const assistantIndex = messages.findLastIndex(
			(message) => message.role === "assistant"
		);

		if (assistantIndex === -1) {
			return messages;
		}

		const assistantMessage = messages[assistantIndex];
		if (!assistantMessage) {
			return messages;
		}

		const nextMessages = [...messages];
		nextMessages[assistantIndex] = {
			...finalizeAssistantMessageMetadata(assistantMessage, {
				agent: agentRef.current,
				interrupted: interruptedMessageIdsRef.current.has(assistantMessage.id),
				model: modelRef.current,
				responseTimeMs,
				variant: variantRef.current,
			}),
		};

		return nextMessages;
	};

	const persistMessages = (messages: CodingAgentUIMessage[]) => {
		getConversationStore()
			.persistMessages({
				agent: agentRef.current,
				messages,
				model: conversationModelRef.current,
				sessionId,
				variant: conversationVariantRef.current,
			})
			.catch(() => undefined);
	};

	const finalizeAndPersistMessages = (messages: CodingAgentUIMessage[]) => {
		const finalizedMessages = finalizeAssistantMessages(messages);
		setMessagesRef.current?.(finalizedMessages);
		persistMessages(finalizedMessages);
	};

	const chat = useAiChat<CodingAgentUIMessage>({
		id: sessionId,
		messages: initialMessages,
		onFinish: ({ messages }) => {
			finalizeAndPersistMessages(messages);
			notifyHostedCompletion(modelRef.current, onHostedCompletion);
		},
		onToolCall: createChatToolCallHandler({
			addToolOutputRef,
			approvalQueue: approvalQueueRef.current,
			mcp,
			mcpSnapshotRef,
			openApproval,
			permissionRef,
			resolvedAgentRef,
			resolvePermission,
			sandbox,
			service,
			skillExecutionRef,
		}),
		sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
		transport,
	});
	addToolOutputRef.current = chat.addToolOutput;
	setMessagesRef.current = chat.setMessages;

	const interruptLatestAssistantMessage = () => {
		const startedAt = requestStartedAtRef.current;
		const responseTimeMs =
			startedAt === null ? undefined : Math.max(0, Date.now() - startedAt);
		const targetIndex = findCurrentTurnInterruptTargetIndex(chat.messages);

		if (targetIndex === -1) {
			chat.stop();
			return;
		}

		const targetMessage = chat.messages[targetIndex];
		if (!targetMessage) {
			chat.stop();
			return;
		}

		if (targetMessage.role === "assistant") {
			interruptedMessageIdsRef.current.add(targetMessage.id);
		}
		const nextMessages = [...chat.messages];
		nextMessages[targetIndex] = {
			...finalizeAssistantMessageMetadata(targetMessage, {
				agent: agentRef.current,
				interrupted: true,
				model: modelRef.current,
				responseTimeMs,
				variant: variantRef.current,
			}),
		};

		setMessagesRef.current?.(nextMessages);
		persistMessages(nextMessages);
		chat.stop();
	};

	const createTurnSkillExecution = async (): Promise<SkillExecution> => {
		const permission = await resolvePermission();
		const catalog = await discoverSkillCatalog(config, (name) =>
			permission.decide("skill", name)
		);
		const execution = createSkillExecution(catalog);
		skillExecutionRef.current = execution;
		skillToolRef.current = buildSkillToolDefinition(catalog);
		setCatalogDiagnostic(summarizeCatalogDiagnostics(catalog));
		return execution;
	};

	const submit = async ({
		agent,
		conversationModel,
		conversationVariant,
		model,
		variant,
		resolvedAgent,
		userText,
		files = [],
		skill,
	}: SubmitChatParams): Promise<SubmitChatOutcome> => {
		agentRef.current = agent;
		resolvedAgentRef.current = resolvedAgent;
		conversationModelRef.current = conversationModel;
		conversationVariantRef.current = conversationVariant;
		modelRef.current = model;
		variantRef.current = variant;
		requestStartedAtRef.current = Date.now();

		await createTurnSkillExecution();
		let explicitSkill: SkillRequestContext | undefined;
		if (skill) {
			const permission = await resolvePermission();
			const execution = skillExecutionRef.current;
			if (execution === null) {
				return { rejected: true, reason: "Skill catalog is unavailable" };
			}
			if (approvalQueueRef.current === null) {
				approvalQueueRef.current = createApprovalQueue<ToolApprovalRequest>();
			}
			const activation = await activateExplicitSkill(skill, {
				approvalQueue: approvalQueueRef.current,
				execution,
				openApproval,
				permission,
				service,
			});
			if (!activation.ok) {
				return { rejected: true, reason: activation.reason };
			}
			explicitSkill = activation.skill;
		}

		const metadata = {
			agent,
			model,
			variant,
			...(explicitSkill
				? { skill: createSkillSnapshot(explicitSkill, "explicit") }
				: {}),
		};
		const optimisticMessage = createUserMessage(userText, metadata, [], files);
		chat.setMessages((messages) => [
			...sanitizeSkillToolParts(messages),
			optimisticMessage,
		]);
		setIsPreparingMessage(true);

		try {
			const fileMentions = await resolveFileMentionParts(userText);
			await chat.sendMessage({
				messageId: optimisticMessage.id,
				metadata,
				parts: createChatMessageParts(userText, fileMentions, files),
			});
			return { rejected: false };
		} catch (error) {
			chat.setMessages((messages) =>
				messages.filter(({ id }) => id !== optimisticMessage.id)
			);
			throw error;
		} finally {
			setIsPreparingMessage(false);
		}
	};

	const continueLastMessage = async (
		agent: AgentId,
		model: ChatModelSelection,
		variant?: ModelVariant,
		resolvedAgent?: ResolvedAgentRuntime,
		conversationModel: ChatModelSelection = model,
		conversationVariant: ModelVariant | undefined = variant
	): Promise<SubmitChatOutcome> => {
		agentRef.current = agent;
		resolvedAgentRef.current = resolvedAgent;
		conversationModelRef.current = conversationModel;
		conversationVariantRef.current = conversationVariant;
		modelRef.current = model;
		variantRef.current = variant;
		requestStartedAtRef.current = Date.now();

		// A retry or auto-start is a new execution: permissions and Skill
		// contents are re-evaluated from current state.
		await createTurnSkillExecution();

		// A session created with an explicit Skill (for example the initial
		// command-line prompt) or retried after an interruption carries Skill
		// metadata on its user message — sanitized activation metadata after a
		// reload, the full snapshot in memory. Either way the Skill is
		// re-authorized and re-snapshotted from current content, and the user
		// message metadata is refreshed so the transport injects the live body.
		const originatingUserMessage = [...chat.messages]
			.reverse()
			.find(({ role }) => role === "user");
		const parsedSkill = codingMessageSkillSchema.safeParse(
			originatingUserMessage?.metadata?.skill
		);
		if (parsedSkill.success) {
			const execution = skillExecutionRef.current;
			if (execution !== null) {
				if (approvalQueueRef.current === null) {
					approvalQueueRef.current = createApprovalQueue<ToolApprovalRequest>();
				}
				const activation = await activateExplicitSkill(
					{
						arguments: parsedSkill.data.arguments ?? "",
						instructions: "",
						name: parsedSkill.data.name,
					},
					{
						approvalQueue: approvalQueueRef.current,
						execution,
						openApproval,
						permission: await resolvePermission(),
						service,
					}
				);
				if (!activation.ok) {
					return { rejected: true, reason: activation.reason };
				}
				chat.setMessages((messages) =>
					messages.map((message) =>
						message.id === originatingUserMessage?.id
							? {
									...message,
									metadata: {
										...message.metadata,
										skill: createSkillSnapshot(activation.skill, "explicit"),
									},
								}
							: message
					)
				);
			}
		}

		chat.setMessages((messages) => sanitizeSkillToolParts(messages));
		await chat.sendMessage();
		return { rejected: false };
	};

	return {
		abort: chat.stop,
		catalogDiagnostic,
		continueLastMessage,
		error: chat.error,
		interrupt: interruptLatestAssistantMessage,
		messages: chat.messages,
		status: chat.status,
		isPreparingMessage,
		submit,
	};
}

const summarizeCatalogDiagnostics = (catalog: SkillCatalog): string | null => {
	if (catalog.diagnostics.length === 0) {
		return null;
	}
	const invalidCount = catalog.diagnostics.filter(
		({ code }) => code === "invalid-skill"
	).length;
	const overBudget = catalog.diagnostics.some(
		({ code }) => code === "catalog-over-budget"
	);
	if (invalidCount === 0 && !overBudget) {
		return null;
	}
	const summary: string[] = [];
	if (invalidCount > 0) {
		summary.push(
			`${invalidCount} Skill${invalidCount === 1 ? "" : "s"} omitted (validation limits)`
		);
	}
	if (overBudget) {
		summary.push("Skill tool disabled (catalog over budget)");
	}
	return `Skill catalog: ${summary.join("; ")}`;
};
