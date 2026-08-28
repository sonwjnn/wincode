import { lstat } from "node:fs/promises";
import {
	type CodingToolName,
	codingToolDefinitions,
	codingToolNames,
	getReadResourcePath,
} from "@wincode/ai";
import type { WorkspacePolicy } from "@wincode/ai/workspace";
import {
	MCP_PERMISSION_RESOURCE,
	mcpDeniedByPolicyText,
} from "@/modules/mcp/registry";
import {
	canonicalizeExternalPath,
	canonicalizeResource,
	composePermissionDecisions,
	expandHomeInPath,
	externalParentDirectoryGlob,
	isCdFamilyCommand,
	normalizeShellCommand,
	type PermissionDecision,
	type PermissionService,
	parseShellCommandNodes,
	resolveApproval,
	type ShellCommandNode,
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
	| { kind: "allow"; input?: unknown }
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
	onAbort?: (request: ToolApprovalRequest) => void;
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
const resolveReadGatePath = async (
	input: string,
	sandbox: WorkspacePolicy
): Promise<string> => {
	const resourcePath = getReadResourcePath(input);
	if (resourcePath === input) {
		return input;
	}
	try {
		await sandbox.resolveExistingPath(expandHomeInPath(input));
		return input;
	} catch {
		const canonicalLiteralPath = await canonicalizeExternalPath(
			input,
			sandbox.root
		);
		try {
			await lstat(canonicalLiteralPath);
			return input;
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				return resourcePath;
			}
			return input;
		}
	}
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
	onAbort?: (request: ToolApprovalRequest) => void;
	openApproval: ToolGateDeps["openApproval"];
	service: PermissionService;
};

type InternalApprovalRequest = {
	checks: ReadonlyArray<{
		action: string;
		decision: PermissionDecision;
		resource: string;
	}>;
	/** True when this is the third identical call (doom_loop, ADR-0008). */
	doomAsk?: boolean;
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
	{ checks, doomAsk, request, safety }: InternalApprovalRequest,
	{ approvalQueue, onAbort, openApproval, service }: InternalApprovalDeps,
	recordGrant: () => void
): Promise<GateOutcome> => {
	const effective = checks.map(({ action, decision, resource }) =>
		resolveApproval({
			action,
			// The doom_loop ask is ordinary: composed before grants and auto
			// approval so `--auto` still bypasses it while an explicit deny
			// (already most-restrictive) never does (ADR-0008).
			decision: composePermissionDecisions(
				decision,
				doomAsk === true ? "ask" : "allow"
			),
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
		abort: () => {
			handle.abort();
			onAbort?.(request);
		},
		allow: (remember) => handle.allow(remember),
		cancel: () => handle.reject(),
		reject: (feedback) => handle.reject(feedback),
	});
	const outcome = await handle.outcome;
	if (outcome.decision === "abort") {
		return {
			errorText: request.description,
			kind: "reject",
		};
	}
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
	// option (ADR-0003, ADR-0008).
	if (outcome.remember && !safety) {
		recordGrant();
	}
	return { kind: "allow" };
};

/**
 * Composes the shell policy decision for one command (ADR-0008). Every
 * command node is its own resource, composed most-restrictively, with
 * cd-family nodes exempt; the raw-command decision seeds the composition so
 * an explicit deny or ask holds even when the parse yields no command node
 * (for example a bare assignment or a redirect-only command). An unparseable
 * command fails closed to ask.
 */
const decideShellCommand = (
	command: string,
	nodes: ShellCommandNode[] | undefined,
	permission: ToolPermission
): PermissionDecision => {
	if (nodes === undefined) {
		return composePermissionDecisions(
			permission.decide("shell", command),
			"ask"
		);
	}
	let decision = permission.decide("shell", command);
	let hasExecutableNode = false;
	for (const node of nodes) {
		if (isCdFamilyCommand(node.command)) {
			continue;
		}
		hasExecutableNode = true;
		decision = composePermissionDecisions(
			decision,
			permission.decide("shell", node.text)
		);
	}
	if (!hasExecutableNode && nodes.length > 0) {
		// Every node is cd-family: the shell ask is skipped entirely, but an
		// explicit deny on the command still holds.
		return decision === "deny" ? "deny" : "allow";
	}
	return decision;
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
 * canonicalization, the external-directory composition, per-node shell
 * evaluation, the doom_loop repeat guard, the conversation approval queue,
 * exact temporary-grant recording, and the deny/reject wording each family
 * emits. Callers map the settled outcome onto their own output channel; the
 * gate emits nothing.
 */
export const createToolGate = ({
	approvalQueue: providedApprovalQueue,
	onAbort,
	openApproval,
	resolvePermission,
	sandbox,
	service,
}: ToolGateDeps): ToolGate => {
	const approvalQueue =
		providedApprovalQueue ?? createApprovalQueue<ToolApprovalRequest>();
	const approvalDeps = { approvalQueue, onAbort, openApproval, service };

	const gateCodingToolCall = async (
		toolCall: { input: unknown; toolCallId: string; toolName: string },
		permission: ToolPermission,
		doomAsk: boolean
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
					doomAsk,
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
		const pathInput =
			tool === "read"
				? await resolveReadGatePath(gateResource.input, sandbox)
				: gateResource.input;

		try {
			const canonical = await canonicalizeResource(
				expandHomeInPath(pathInput),
				sandbox
			);
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
					doomAsk,
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
			const externalPathInput = pathInput;
			let resource: string;
			try {
				resource = await canonicalizeExternalPath(
					externalPathInput,
					sandbox.root
				);
			} catch {
				return {
					errorText: `${label} path is outside the workspace: ${externalPathInput}`,
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
					doomAsk,
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
			const outcome = withErrorText(
				settled,
				staticDenialText(label, gateResource.pattern ?? resource),
				(feedback) =>
					staticRejectionText(label, gateResource.pattern ?? resource, feedback)
			);
			if (outcome.kind !== "allow" || gateResource.pattern !== undefined) {
				return outcome;
			}
			return {
				...outcome,
				input:
					typeof toolCall.input === "object" &&
					toolCall.input !== null &&
					!Array.isArray(toolCall.input)
						? { ...toolCall.input, path: resource }
						: { path: resource },
			};
		}
	};

	/**
	 * Enforces the Tool Permission policy for a `shell` tool call (ADR-0008).
	 * The command is parsed per node: each command node is its own resource
	 * evaluated against the shell rules, composed most-restrictively, and
	 * cd-family nodes are exempt. An unparseable command fails closed to ask,
	 * so a parser bug never silently allows. Always approvals persist the exact
	 * normalized command as the grant key, so approving one command never
	 * unlocks its siblings. A `cwd` outside the workspace still composes the
	 * `external_directory` boundary (canonicalized and symlink-resolved like
	 * file tools).
	 */
	const gateShellToolCall = async (
		toolCall: { input: unknown; toolCallId: string },
		permission: ToolPermission,
		doomAsk: boolean
	): Promise<GateOutcome> => {
		const command = getStringField(toolCall.input, "command");
		if (!command) {
			// Missing command: left ungated so the runner reports the validation
			// error, mirroring the other static tools.
			return { kind: "allow" };
		}
		const normalized = normalizeShellCommand(command);
		const nodes = await parseShellCommandNodes(command);
		const operationDecision = decideShellCommand(command, nodes, permission);
		const cwd = getStringField(toolCall.input, "cwd");
		const request = (external: boolean): ToolApprovalRequest => ({
			description: codingToolDefinitions.shell.description,
			identity: [
				{ label: "tool", value: "shell" },
				{ label: "resource", value: command },
				...(external ? [{ label: "scope", value: "external" }] : []),
			],
			input: toolCall.input,
			safety: permission.safety,
			toolCallId: toolCall.toolCallId,
		});

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
							resource: normalized,
						},
					],
					doomAsk,
					request: request(false),
					safety: permission.safety,
				},
				approvalDeps,
				() => service.grant("shell", normalized)
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
						resource: normalized,
					},
				],
				doomAsk,
				request: request(true),
				safety: permission.safety,
			},
			approvalDeps,
			() => {
				service.grant(
					"external_directory",
					externalParentDirectoryGlob(externalResource ?? "")
				);
				service.grant("shell", normalized);
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
		call: Extract<GateCall, { family: "mcp" }>,
		doomAsk: boolean
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
				doomAsk,
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
		return withErrorText(
			settled,
			mcpDeniedByPolicyText(call.toolName),
			(feedback) => mcpRejectionText(call.toolName, feedback)
		);
	};

	/**
	 * Gates one Skill Activation approval, resolving policy inside the gate.
	 * Skill wording never carries rejection feedback: the Skill runners surface a
	 * structured rejection result instead.
	 */
	const gateSkillCall = async (
		call: Extract<GateCall, { family: "skill" }>,
		doomAsk: boolean
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
				doomAsk,
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

	// doom_loop (ADR-0008): per-conversation repeat tracking keyed by the
	// (family, tool, input) triple. The third identical call turns the decision
	// into an ordinary ask that `--auto` may bypass but an explicit deny never
	// does; any differing call resets the run.
	const DOOM_LOOP_THRESHOLD = 3;
	let lastDoomKey: string | undefined;
	let doomRepeatCount = 0;
	const doomKeyOf = (call: GateCall): string => {
		if (call.family === "mcp") {
			return `mcp:${call.action}:${JSON.stringify(call.input)}`;
		}
		if (call.family === "skill") {
			return `skill:${call.name}:${JSON.stringify({ name: call.name })}`;
		}
		if (call.family === "shell") {
			return `shell:${JSON.stringify(call.toolCall.input)}`;
		}
		return `coding:${call.toolCall.toolName}:${JSON.stringify(call.toolCall.input)}`;
	};
	const trackDoomLoop = (call: GateCall): boolean => {
		const key = doomKeyOf(call);
		if (key === lastDoomKey) {
			doomRepeatCount += 1;
		} else {
			lastDoomKey = key;
			doomRepeatCount = 1;
		}
		return doomRepeatCount >= DOOM_LOOP_THRESHOLD;
	};

	const gate = async (call: GateCall): Promise<GateOutcome> => {
		if (call.family === "mcp") {
			return gateMcpToolCall(call, trackDoomLoop(call));
		}
		if (call.family === "skill") {
			return gateSkillCall(call, trackDoomLoop(call));
		}
		if (call.family === "shell") {
			const permission = await resolvePermission();
			return gateShellToolCall(call.toolCall, permission, trackDoomLoop(call));
		}
		if (call.family === "coding") {
			const permission = await resolvePermission();
			return gateCodingToolCall(call.toolCall, permission, trackDoomLoop(call));
		}
		return { errorText: "Unknown tool authorization family", kind: "deny" };
	};

	return { gate };
};
