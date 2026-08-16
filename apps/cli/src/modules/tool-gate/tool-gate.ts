import {
	type CodingToolName,
	codingToolDefinitions,
	codingToolNames,
} from "@wincode/ai";
import type { WorkspacePolicy } from "@wincode/ai/workspace";
import { MCP_PERMISSION_RESOURCE } from "@/modules/mcp/registry";
import {
	canonicalizeExternalPath,
	canonicalizeResource,
	composePermissionDecisions,
	DESTRUCTIVE_SHELL_SAFETY_MESSAGE,
	expandHomeInPath,
	externalParentDirectoryGlob,
	isDestructiveShellCommand,
	type PermissionDecision,
	type PermissionService,
	resolveApproval,
	STATIC_TOOL_PERMISSION_ACTIONS,
	type ToolPermission,
} from "@/modules/permissions";
import {
	type ApprovalQueue,
	createApprovalQueue,
} from "@/shared/providers/approval/approval-queue";
import { formatRejectionFeedback } from "@/shared/providers/approval/format";
import type {
	ToolApprovalActions,
	ToolApprovalRequest,
} from "@/shared/providers/approval/types";

/**
 * The settled outcome of one tool call gated through the Tool Gate. `allow`
 * clears the call to run; `deny` and `reject` block it and carry the
 * model-visible error text in the family's exact wording. `reject` outcomes
 * additionally carry the bounded correction feedback where the family surfaces
 * it (coding, shell, and MCP).
 */
export type GateOutcome =
	| { kind: "allow" }
	| { kind: "deny"; errorText: string }
	| { kind: "reject"; errorText: string; feedback?: string };

/**
 * One tool call to gate. `coding` and `shell` resolve their own resource,
 * policy decision, and external-directory boundary from the raw call input.
 * `mcp` carries the independent Agent and server decisions for composition by
 * the gate. `skill` carries catalog availability so denies settle before an
 * unavailable lookup while asks never prompt for an unavailable Skill.
 */
export type GateCall =
	| {
			family: "coding";
			toolCall: { input: unknown; toolCallId: string; toolName: string };
	  }
	| {
			family: "mcp";
			action: string;
			agentDecision: PermissionDecision;
			description: string;
			input: unknown;
			safety: boolean;
			serverDecision: PermissionDecision;
			toolCallId: string;
			toolName: string;
	  }
	| {
			family: "shell";
			toolCall: { input: unknown; toolCallId: string };
	  }
	| {
			family: "skill";
			available: boolean;
			description: string;
			name: string;
			toolCallId?: string;
	  };

export type ToolGate = {
	gate(call: GateCall): Promise<GateOutcome>;
};

export type ToolGateDeps = {
	approvalQueue?: ApprovalQueue<ToolApprovalRequest>;
	openApproval: (
		request: ToolApprovalRequest,
		actions: ToolApprovalActions
	) => void;
	resolvePermission: () => Promise<ToolPermission>;
	sandbox: WorkspacePolicy;
	service: PermissionService;
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
	codingToolNames.some((tool) => tool === name);

const getStringField = (input: unknown, field: string): string | undefined => {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return;
	}
	const candidate = Reflect.get(input, field);
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

const staticDenialText = (label: string, resource: string): string =>
	`${label} denied by policy: ${resource}`;

const staticRejectionText = (
	label: string,
	resource: string,
	feedback?: string
): string =>
	feedback === undefined
		? `${label} was not approved: ${resource}`
		: `${label} was not approved: ${resource} — ${feedback}`;

const mcpDenialText = (toolName: string): string =>
	`MCP tool '${toolName}' is denied by policy`;

const mcpRejectionText = (toolName: string, feedback?: string): string =>
	feedback === undefined
		? `MCP tool '${toolName}' was not approved`
		: `MCP tool '${toolName}' was not approved — ${feedback}`;

const skillDenialText = (name: string): string =>
	`Skill "${name}" is denied by policy`;

const skillRejectionText = (name: string): string =>
	`Skill "${name}" was not approved`;

type InternalApprovalDeps = {
	approvalQueue: ApprovalQueue<ToolApprovalRequest>;
	openApproval: ToolGateDeps["openApproval"];
	service: PermissionService;
};

type InternalApprovalRequest = {
	checks: ReadonlyArray<{
		action: string;
		decision: PermissionDecision;
		resource: string;
	}>;
	request: ToolApprovalRequest;
	safety: boolean;
};

/**
 * The single approval path shared by every gated tool family. It applies
 * temporary grants and auto approval to the raw policy `decision`
 * (`resolveApproval`), and for an `ask` enqueues the request on the
 * conversation approval queue, opens the shared inline approval panel, and
 * awaits the outcome. A remembered "always" outcome records the grant only
 * when the request is not under the safety ceiling, and reject feedback is
 * bounded before it reaches the Agent.
 */
const settleApproval = async (
	{ checks, request, safety }: InternalApprovalRequest,
	{ approvalQueue, openApproval, service }: InternalApprovalDeps,
	recordGrant: () => void
): Promise<GateOutcome> => {
	const effective = checks.map(({ action, decision, resource }) =>
		resolveApproval({
			action,
			decision,
			isAutoApproval: () => service.isAutoApproval(),
			isGranted: (grantedAction, grantedResource) =>
				service.isGranted(grantedAction, grantedResource),
			resource,
			safety,
		})
	);
	if (effective.includes("deny")) {
		return { errorText: request.description, kind: "deny" };
	}
	if (effective.every((decision) => decision === "allow")) {
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
			errorText: request.description,
			feedback: formatRejectionFeedback(outcome.feedback),
			kind: "reject",
		};
	}
	// The safety ceiling is enforced at the single grant-recording site: a
	// remembered "always" outcome for a safety ask records nothing, so no
	// grant can bypass a manual-only ask regardless of who presents the
	// option (ADR-0003, ADR-0005).
	if (outcome.remember && !safety) {
		recordGrant();
	}
	return { kind: "allow" };
};

const withErrorText = (
	outcome: GateOutcome,
	denial: string,
	rejection: (feedback?: string) => string
): GateOutcome => {
	if (outcome.kind === "deny") {
		return { ...outcome, errorText: denial };
	}
	if (outcome.kind === "reject") {
		return { ...outcome, errorText: rejection(outcome.feedback) };
	}
	return outcome;
};

/**
 * The deep Tool Gate module: one interface enforcing Tool Permission at
 * execution time for every tool family. It owns resource resolution and
 * canonicalization, the external-directory composition, the destructive-shell
 * ceiling, the conversation approval queue, temporary-grant recording, and the
 * deny/reject wording each family emits. Callers map the settled outcome onto
 * their own output channel; the gate emits nothing.
 */
export const createToolGate = ({
	approvalQueue: providedApprovalQueue,
	openApproval,
	resolvePermission,
	sandbox,
	service,
}: ToolGateDeps): ToolGate => {
	const approvalQueue =
		providedApprovalQueue ?? createApprovalQueue<ToolApprovalRequest>();
	const approvalDeps = { approvalQueue, openApproval, service };

	const gateCodingToolCall = async (
		toolCall: { input: unknown; toolCallId: string; toolName: string },
		permission: ToolPermission
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: authorization branches are intentionally kept in one gate
	): Promise<GateOutcome> => {
		if (!isCodingToolName(toolCall.toolName)) {
			return {
				errorText: `Unknown coding tool '${toolCall.toolName}'`,
				kind: "deny",
			};
		}
		if (toolCall.toolName === "shell") {
			return {
				errorText: "Shell tool call used the coding authorization family",
				kind: "deny",
			};
		}
		const tool = toolCall.toolName;
		const gateResource = resolveGateResource(tool, toolCall.input);
		if (gateResource === undefined) {
			return { kind: "allow" };
		}
		const label = STATIC_TOOL_LABELS[tool];
		const action = STATIC_TOOL_PERMISSION_ACTIONS[tool];
		const requestFor = (
			resource: string,
			external: boolean,
			boundaryResource?: string
		): ToolApprovalRequest => ({
			description: codingToolDefinitions[tool].description,
			identity: [
				{ label: "tool", value: tool },
				{ label: "resource", value: resource },
				...(boundaryResource === undefined
					? []
					: [{ label: "boundary", value: boundaryResource }]),
				...(external ? [{ label: "scope", value: "external" }] : []),
			],
			input: toolCall.input,
			safety: permission.safety,
			toolCallId: toolCall.toolCallId,
		});

		if (gateResource.kind === "literal") {
			const settled = await settleApproval(
				{
					checks: [
						{
							action,
							decision: permission.decide(action, gateResource.value),
							resource: gateResource.value,
						},
					],
					request: requestFor(gateResource.value, false),
					safety: permission.safety,
				},
				approvalDeps,
				() => service.grant(action, gateResource.value)
			);
			return withErrorText(
				settled,
				staticDenialText(label, gateResource.value),
				(feedback) => staticRejectionText(label, gateResource.value, feedback)
			);
		}

		try {
			const canonical = await canonicalizeResource(gateResource.input, sandbox);
			// Grep gates its operation against the regex; its path only decides the
			// external boundary. Other path tools gate against the canonical path.
			const resource =
				gateResource.pattern ??
				(canonical === "" ? WORKSPACE_ROOT_RESOURCE : canonical);
			const settled = await settleApproval(
				{
					checks: [
						{ action, decision: permission.decide(action, resource), resource },
					],
					request: requestFor(resource, false),
					safety: permission.safety,
				},
				approvalDeps,
				() => service.grant(action, resource)
			);
			return withErrorText(
				settled,
				staticDenialText(label, gateResource.pattern ?? resource),
				(feedback) =>
					staticRejectionText(label, gateResource.pattern ?? resource, feedback)
			);
		} catch {
			// The path is outside the workspace: the external_directory boundary
			// applies in addition to the operation policy.
			const pathInput = getStringField(toolCall.input, "path") ?? "";
			let resource: string;
			try {
				resource = await canonicalizeExternalPath(pathInput, sandbox.root);
			} catch {
				return {
					errorText: `${label} path is outside the workspace: ${pathInput}`,
					kind: "deny",
				};
			}

			// The operation keeps its own resource (the regex for grep, the canonical
			// path otherwise); external_directory adds a boundary on top of it.
			const settled = await settleApproval(
				{
					checks: [
						{
							action: "external_directory",
							decision: permission.decide("external_directory", resource),
							resource,
						},
						{
							action,
							decision: permission.decide(
								action,
								gateResource.pattern ?? resource
							),
							resource: gateResource.pattern ?? resource,
						},
					],
					request: requestFor(
						gateResource.pattern ?? resource,
						true,
						gateResource.pattern === undefined ? undefined : resource
					),
					safety: permission.safety,
				},
				approvalDeps,
				() => {
					service.grant(
						"external_directory",
						externalParentDirectoryGlob(resource)
					);
					service.grant(action, gateResource.pattern ?? resource);
				}
			);
			return withErrorText(
				settled,
				staticDenialText(label, gateResource.pattern ?? resource),
				(feedback) =>
					staticRejectionText(label, gateResource.pattern ?? resource, feedback)
			);
		}
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
		toolCall: { input: unknown; toolCallId: string },
		permission: ToolPermission
	): Promise<GateOutcome> => {
		const command = getStringField(toolCall.input, "command");
		if (!command) {
			// Missing command: left ungated so the runner reports the validation
			// error, mirroring the other static tools.
			return { kind: "allow" };
		}
		const cwd = getStringField(toolCall.input, "cwd");
		const destructive = isDestructiveShellCommand(command);
		const request = (external: boolean): ToolApprovalRequest => ({
			description: codingToolDefinitions.shell.description,
			identity: [
				{ label: "tool", value: "shell" },
				{ label: "resource", value: command },
				...(external ? [{ label: "scope", value: "external" }] : []),
			],
			input: toolCall.input,
			safety: permission.safety || destructive,
			...(destructive
				? { safetyReason: DESTRUCTIVE_SHELL_SAFETY_MESSAGE }
				: {}),
			toolCallId: toolCall.toolCallId,
		});
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
					return {
						errorText: `Shell working directory is outside the workspace: ${cwd}`,
						kind: "deny",
					};
				}
			}
		}

		if (externalResource === undefined) {
			const settled = await settleApproval(
				{
					checks: [
						{
							action: "shell",
							decision: operationDecision,
							resource: SHELL_GRANT_RESOURCE,
						},
					],
					request: request(false),
					safety,
				},
				approvalDeps,
				() => service.grant("shell", SHELL_GRANT_RESOURCE)
			);
			return withErrorText(
				settled,
				staticDenialText("Shell", command),
				(feedback) => staticRejectionText("Shell", command, feedback)
			);
		}

		const settled = await settleApproval(
			{
				checks: [
					{
						action: "external_directory",
						decision: permission.decide("external_directory", externalResource),
						resource: externalResource,
					},
					{
						action: "shell",
						decision: operationDecision,
						resource: SHELL_GRANT_RESOURCE,
					},
				],
				request: request(true),
				safety,
			},
			approvalDeps,
			() => {
				service.grant(
					"external_directory",
					externalParentDirectoryGlob(externalResource ?? "")
				);
				service.grant("shell", SHELL_GRANT_RESOURCE);
			}
		);
		return withErrorText(
			settled,
			staticDenialText("Shell", command),
			(feedback) => staticRejectionText("Shell", command, feedback)
		);
	};

	/**
	 * Gates one dynamic MCP tool call through the shared approval path, keyed by
	 * the tool's logical name and the single `*` resource. The composed decision
	 * already baked the Agent+server policy and any safety ceiling into the
	 * snapshot tool, so grants and auto approval may satisfy an ordinary ask, a
	 * safety ask always prompts, and an explicit deny is never bypassed. An
	 * "always" outcome grants the exact logical name.
	 */
	const gateMcpToolCall = async (
		call: Extract<GateCall, { family: "mcp" }>
	) => {
		const composedDecision = composePermissionDecisions(
			call.serverDecision,
			call.agentDecision
		);
		const decision =
			call.safety && composedDecision !== "deny" ? "ask" : composedDecision;
		const settled = await settleApproval(
			{
				checks: [
					{
						action: call.action,
						decision,
						resource: MCP_PERMISSION_RESOURCE,
					},
				],
				request: {
					description: call.description,
					identity: [
						{ label: "tool", value: call.action },
						{ label: "resource", value: MCP_PERMISSION_RESOURCE },
					],
					input: call.input,
					safety: call.safety,
					toolCallId: call.toolCallId,
				},
				safety: call.safety,
			},
			approvalDeps,
			() => service.grant(call.action, MCP_PERMISSION_RESOURCE)
		);
		return withErrorText(settled, mcpDenialText(call.toolName), (feedback) =>
			mcpRejectionText(call.toolName, feedback)
		);
	};

	/**
	 * Gates one Skill Activation approval, resolving policy inside the gate.
	 * Skill wording never carries rejection feedback: the Skill runners surface a
	 * structured rejection result instead.
	 */
	const gateSkillCall = async (
		call: Extract<GateCall, { family: "skill" }>
	): Promise<GateOutcome> => {
		const permission = await resolvePermission();
		const decision = permission.decide("skill", call.name);
		if (!call.available && decision !== "deny") {
			return { kind: "allow" };
		}
		const settled = await settleApproval(
			{
				checks: [
					{
						action: "skill",
						decision,
						resource: call.name,
					},
				],
				request: {
					description: call.description,
					identity: [
						{ label: "tool", value: "skill" },
						{ label: "skill", value: call.name },
					],
					input: { name: call.name },
					safety: permission.safety,
					toolCallId: call.toolCallId,
				},
				safety: permission.safety,
			},
			approvalDeps,
			() => service.grant("skill", call.name)
		);
		return withErrorText(settled, skillDenialText(call.name), () =>
			skillRejectionText(call.name)
		);
	};

	const gate = async (call: GateCall): Promise<GateOutcome> => {
		if (call.family === "mcp") {
			return gateMcpToolCall(call);
		}
		if (call.family === "skill") {
			return gateSkillCall(call);
		}
		if (call.family === "shell") {
			const permission = await resolvePermission();
			return gateShellToolCall(call.toolCall, permission);
		}
		if (call.family === "coding") {
			const permission = await resolvePermission();
			return gateCodingToolCall(call.toolCall, permission);
		}
		return { errorText: "Unknown tool authorization family", kind: "deny" };
	};

	return { gate };
};
