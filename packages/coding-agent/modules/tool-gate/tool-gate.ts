import { lstat } from "node:fs/promises";
import path from "node:path";
import type { AgentId, ToolCallId } from "@wincode/agent-core";
import {
	isObjectLike,
	isPlainObject,
	isString,
	isUndefined,
} from "@wincode/runtime-utils";
import {
	MCP_PERMISSION_RESOURCE,
	mcpDeniedByPolicyText,
} from "@/modules/mcp/registry";
import { resolveApproval } from "@/modules/permissions/approval-resolution";
import { canonicalizeResource } from "@/modules/permissions/canonical";
import {
	canonicalizeExternalPath,
	expandHomeInPath,
	externalParentDirectoryGlob,
} from "@/modules/permissions/external-directory";
import type { PermissionService } from "@/modules/permissions/permission-service";
import {
	composePermissionDecisions,
	type PermissionDecision,
	STATIC_TOOL_PERMISSION_ACTIONS,
	type ToolPermission,
} from "@/modules/permissions/policy";
import {
	isCdFamilyCommand,
	normalizeShellCommand,
	parseShellCommandNodes,
	type ShellCommandNode,
} from "@/modules/permissions/shell-command";
import type { SessionApprovalOutcome } from "@/modules/sessions/engine/types";
import type { WorkspacePolicy } from "@/modules/tools";
import {
	byteLength,
	type CodingToolName,
	codingToolCatalog,
	codingToolNames,
	getPatchResourcePaths,
	getReadResourcePath,
	getToolResourceLimits,
	isElevatedResourceProfile,
	RESOURCE_LIMIT_PERMISSION_ACTION,
	rewritePatchResourcePath,
	rewritePatchResourcePaths,
	type ToolResourceLimits,
	validateMultiEditPatch,
} from "@/modules/tools";
import { formatRejectionFeedback } from "@/shared/providers/approval/format";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";

/**
 * The settled outcome of one tool call gated through the Tool Gate. `allow`
 * clears the call to run; `deny` and `reject` block it and carry the
 * model-visible error text in the family's exact wording. `reject` outcomes
 * additionally carry the bounded correction feedback where the family surfaces
 * it (coding, shell, and MCP).
 */
export type GateOutcome =
	| {
			approvedCrossSession?: boolean;
			approvedExternalPaths?: readonly string[];
			approvedWorkspacePaths?: readonly string[];
			input?: unknown;
			kind: "allow";
	  }
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
			agentId?: AgentId;
			family: "coding";
			toolCall: { input: unknown; toolCallId: ToolCallId; toolName: string };
	  }
	| {
			agentId?: AgentId;
			family: "mcp";
			action: string;
			agentDecision: PermissionDecision;
			description: string;
			input: unknown;
			safety: boolean;
			serverDecision: PermissionDecision;
			toolCallId: ToolCallId;
			toolName: string;
	  }
	| {
			agentId?: AgentId;
			family: "shell";
			toolCall: { input: unknown; toolCallId: ToolCallId };
	  }
	| {
			agentId?: AgentId;
			family: "skill";
			available: boolean;
			description: string;
			name: string;
			toolCallId?: ToolCallId;
	  };
export type ToolGate = {
	gate(call: GateCall): Promise<GateOutcome>;
};

/**
 * The session's single approval settlement path. The Tool Gate registers a
 * request and receives its one settlement; whether a panel action, the
 * close-approvals command, an abort, or shutdown settles it is not the gate's
 * concern.
 */
export type ToolGateApprovalPort = {
	request: (request: ToolApprovalRequest) => Promise<SessionApprovalOutcome>;
};

export type ToolGateDeps = {
	approvals: ToolGateApprovalPort;
	onAbort?: (request: ToolApprovalRequest) => void;
	recoveryWarning?: () => Promise<string | undefined>;
	resolvePermission: (agentId?: AgentId) => Promise<ToolPermission>;
	resolveRecovery?: (
		recoveryId: string
	) => Promise<
		{ originSessionId: string; paths: readonly string[] } | undefined
	>;
	resolveResourceLimits?: (agentId?: AgentId) => Promise<ToolResourceLimits>;
	sandbox: WorkspacePolicy;
	service: PermissionService;
	sessionId?: string;
};

const STATIC_TOOL_LABELS = {
	read: "Read",
	write: "Write",
	edit: "Edit",
	recover: "Recover",
	glob: "Glob",
	grep: "Grep",
	shell: "Shell",
} as const satisfies Record<CodingToolName, string>;

// The workspace-relative POSIX resource that path-based discovery tools gate
// against when no path is supplied and the sandbox canonicalizes the workspace
// root to an empty path.
const WORKSPACE_ROOT_RESOURCE = ".";

const isCodingToolName = (name: string): name is CodingToolName =>
	codingToolNames.some((tool) => tool === name);

const getStringField = (input: unknown, field: string): string | undefined => {
	if (!isPlainObject(input)) {
		return;
	}
	const candidate = Reflect.get(input, field);
	return isString(candidate) ? candidate : undefined;
};

const getPatchResources = (input: unknown): readonly string[] => {
	const patch = getStringField(input, "patch");
	return patch === undefined ? [] : getPatchResourcePaths(patch);
};
type GateResource =
	| {
			kind: "path";
			input: string;
			inputs?: readonly string[];
			pattern?: string;
	  }
	| { kind: "literal"; value: string };

/**
 * Resolves the Permission resource for a static coding tool call. Read, write,
 * and edit gate against a filesystem path; grep and glob gate against their
 * search pattern verbatim, and their optional path is carried for the
 * external-directory boundary. A tool call missing its required input is left
 * ungated so the runner reports the validation error.
 */
const resolveGateResource = (
	tool: CodingToolName,
	input: unknown
): GateResource | undefined => {
	if (tool === "recover") {
		const recoveryId = getStringField(input, "recoveryId");
		return recoveryId === undefined
			? undefined
			: { kind: "literal", value: recoveryId };
	}
	if (tool === "grep" || tool === "glob") {
		const pattern = getStringField(input, "pattern");
		if (!pattern) {
			return;
		}
		const path = getStringField(input, "path");
		return isUndefined(path)
			? { kind: "literal", value: pattern }
			: { input: path, kind: "path", pattern };
	}
	const path = getStringField(input, "path");
	if (tool === "read" && path?.startsWith("artifact://")) {
		return { kind: "literal", value: path };
	}
	if (!isUndefined(path)) {
		return { input: path, kind: "path" };
	}
	if (tool !== "edit") {
		return;
	}
	const patchPaths = getPatchResources(input);
	const patchPath = patchPaths[0];
	return patchPath === undefined
		? undefined
		: { input: patchPath, inputs: patchPaths, kind: "path" };
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
			if (isObjectLike(error) && "code" in error && error.code === "ENOENT") {
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
	isUndefined(feedback)
		? `${label} was not approved: ${resource}`
		: `${label} was not approved: ${resource} — ${feedback}`;

const mcpRejectionText = (toolName: string, feedback?: string): string =>
	isUndefined(feedback)
		? `MCP tool '${toolName}' was not approved`
		: `MCP tool '${toolName}' was not approved — ${feedback}`;

const skillDenialText = (name: string): string =>
	`Skill "${name}" is denied by policy`;

const skillRejectionText = (name: string): string =>
	`Skill "${name}" was not approved`;

type InternalApprovalDeps = Pick<
	ToolGateDeps,
	"approvals" | "onAbort" | "service"
>;

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
const resourceLimitChecks = (limits: ToolResourceLimits) =>
	isElevatedResourceProfile(limits.profile)
		? [
				{
					action: RESOURCE_LIMIT_PERMISSION_ACTION,
					decision: "ask" as const,
					resource: limits.profile,
				},
			]
		: [];

const resourceLimitIdentity = (
	limits: ToolResourceLimits
): ReadonlyArray<{ label: string; value: string }> =>
	isElevatedResourceProfile(limits.profile)
		? [{ label: "limits", value: `${limits.profile} resource profile` }]
		: [];

const grantResourceLimits = (
	service: PermissionService,
	limits: ToolResourceLimits,
	grant: () => void
): void => {
	if (isElevatedResourceProfile(limits.profile)) {
		service.grant(RESOURCE_LIMIT_PERMISSION_ACTION, limits.profile);
	}
	grant();
};

/**
 * The single approval path shared by every gated tool family. It applies
 * temporary grants and auto approval to the raw policy `decision`
 * (`resolveApproval`), and for an `ask` registers the request with the
 * session's approval port and awaits its one settlement. A remembered "always"
 * outcome records the grant only when the request is not under the safety
 * ceiling, reject feedback is bounded before it reaches the Agent, and an abort
 * stops the turn that owns the request once — the settlement is the only route,
 * so two abort triggers cannot both handle the same request.
 */
const settleApproval = async (
	{ checks, doomAsk, request, safety }: InternalApprovalRequest,
	{ approvals, onAbort, service }: InternalApprovalDeps,
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
	const outcome = await approvals.request(request);
	if (outcome.decision === "abort") {
		onAbort?.(request);
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
	if (isUndefined(nodes)) {
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
 * evaluation, the doom_loop repeat guard, exact temporary-grant recording, and
 * the deny/reject wording each family emits; it registers every `ask` with the
 * session's single approval settlement path and never settles one itself.
 * Callers map the settled outcome onto their own output channel; the gate emits
 * nothing.
 */
export const createToolGate = ({
	approvals,
	onAbort,
	recoveryWarning,
	resolvePermission,
	resolveRecovery,
	resolveResourceLimits: resolveResourceLimitsOption,
	sandbox,
	service,
	sessionId,
}: ToolGateDeps): ToolGate => {
	const resolveResourceLimits =
		resolveResourceLimitsOption ??
		(() => Promise.resolve(getToolResourceLimits()));
	const approvalDeps = { approvals, onAbort, service };

	const gateCodingToolCall = async (
		toolCall: { input: unknown; toolCallId: ToolCallId; toolName: string },
		permission: ToolPermission,
		doomAsk: boolean,
		agentId?: AgentId
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: authorization branches are intentionally kept in one gate
	): Promise<GateOutcome> => {
		if (toolCall.toolName === "shell") {
			return gateShellToolCall(toolCall, permission, doomAsk, agentId);
		}
		if (!isCodingToolName(toolCall.toolName)) {
			return {
				errorText: `Unknown coding tool '${toolCall.toolName}'`,
				kind: "deny",
			};
		}
		const tool = toolCall.toolName;
		const resourceLimits = await resolveResourceLimits(agentId);
		const patchInput = getStringField(toolCall.input, "patch");
		if (
			tool === "edit" &&
			patchInput !== undefined &&
			byteLength(patchInput) > resourceLimits.edit.maxPatchBytes
		) {
			return {
				errorText: "Edit patch input exceeds the configured input budget.",
				kind: "deny",
			};
		}
		const editMode = getStringField(toolCall.input, "mode");
		if (
			tool === "edit" &&
			patchInput !== undefined &&
			(editMode === "patch" || editMode === "apply_patch")
		) {
			try {
				validateMultiEditPatch(patchInput, editMode);
			} catch (error) {
				return {
					errorText:
						error instanceof Error
							? error.message
							: "Invalid edit patch input.",
					kind: "reject",
				};
			}
		}
		const gateResource = resolveGateResource(tool, toolCall.input);
		if (isUndefined(gateResource)) {
			return { kind: "allow" };
		}
		const label = STATIC_TOOL_LABELS[tool];
		const action = STATIC_TOOL_PERMISSION_ACTIONS[tool];
		const limitChecks =
			tool === "write" ? [] : resourceLimitChecks(resourceLimits);
		const sloppyEdit =
			tool === "edit" && getStringField(toolCall.input, "mode") === "sloppy";
		const editModeChecks = (resource: string) =>
			sloppyEdit
				? [
						{
							action: "edit:sloppy" as const,
							decision: permission.decide("edit:sloppy", resource),
							resource,
						},
					]
				: [];
		const grantCodingAccess = (resource: string): void => {
			if (sloppyEdit) {
				service.grant("edit:sloppy", resource);
			} else {
				service.grant(action, resource);
			}
		};
		const requestFor = (
			resource: string,
			external: boolean,
			boundaryResource?: string
		): ToolApprovalRequest => ({
			description: codingToolCatalog[tool].description,
			identity: [
				{ label: "tool", value: tool },
				{ label: "resource", value: resource },
				...resourceLimitIdentity(resourceLimits),
				...(isUndefined(boundaryResource)
					? []
					: [{ label: "boundary", value: boundaryResource }]),
				...(external ? [{ label: "scope", value: "external" }] : []),
			],
			input: toolCall.input,
			safety: permission.safety,
			toolCallId: toolCall.toolCallId,
		});
		// Write has no profile-dependent execution budget, so its operation grant
		// must not implicitly authorize an elevated profile for later tool calls.
		const grantApprovedAccess = (grant: () => void): void => {
			if (tool === "write") {
				grant();
				return;
			}
			grantResourceLimits(service, resourceLimits, grant);
		};
		if (
			tool === "edit" &&
			gateResource.kind === "path" &&
			(gateResource.inputs?.length ?? 0) > 1
		) {
			const declaredPaths = gateResource.inputs ?? [gateResource.input];
			const canonicalByDeclared = new Map<string, string>();
			const resources: string[] = [];
			const externalResources: string[] = [];
			const approvedWorkspacePaths: string[] = [];
			const approvedExternalPaths: string[] = [];
			for (const declaredPath of declaredPaths) {
				let resource: string;
				try {
					resource = await canonicalizeResource(
						expandHomeInPath(declaredPath),
						sandbox
					);
					approvedWorkspacePaths.push(path.resolve(sandbox.root, resource));
				} catch {
					resource = await canonicalizeExternalPath(
						expandHomeInPath(declaredPath),
						sandbox.root
					);
					if (!externalResources.includes(resource)) {
						externalResources.push(resource);
					}
					approvedExternalPaths.push(path.resolve(sandbox.root, resource));
				}
				canonicalByDeclared.set(declaredPath, resource);
				if (!resources.includes(resource)) {
					resources.push(resource);
				}
			}
			resources.sort();
			externalResources.sort();
			for (const [declaredPath, resource] of canonicalByDeclared) {
				canonicalByDeclared.set(
					declaredPath,
					path.resolve(sandbox.root, resource)
				);
			}
			const writeSet = resources.join(", ");
			const boundary = externalResources.join(", ");
			const settled = await settleApproval(
				{
					checks: [
						...limitChecks,
						...externalResources.map((resource) => ({
							action: "external_directory" as const,
							decision: permission.decide("external_directory", resource),
							resource,
						})),
						...resources.map((resource) => ({
							action,
							decision: permission.decide(action, resource),
							resource,
						})),
					],
					doomAsk,
					request: requestFor(
						writeSet,
						externalResources.length > 0,
						externalResources.length > 0 ? boundary : undefined
					),
					safety: permission.safety,
				},
				approvalDeps,
				() =>
					grantApprovedAccess(() => {
						for (const resource of externalResources) {
							service.grant(
								"external_directory",
								externalParentDirectoryGlob(resource)
							);
						}
						for (const resource of resources) {
							grantCodingAccess(resource);
						}
					})
			);
			const outcome = withErrorText(
				settled,
				staticDenialText(label, writeSet),
				(feedback) => staticRejectionText(label, writeSet, feedback)
			);
			if (outcome.kind !== "allow") {
				return outcome;
			}
			const input = isPlainObject(toolCall.input) ? toolCall.input : {};
			const patch = Reflect.get(input, "patch");
			if (!isString(patch)) {
				return outcome;
			}
			return {
				...outcome,
				approvedExternalPaths,
				approvedWorkspacePaths,
				input: {
					...input,
					patch: rewritePatchResourcePaths(patch, canonicalByDeclared),
				},
			};
		}
		if (gateResource.kind === "literal") {
			const recoveryAction =
				tool === "recover"
					? getStringField(toolCall.input, "action")
					: undefined;
			const recoveryContext =
				tool === "recover" && resolveRecovery !== undefined
					? await resolveRecovery(gateResource.value)
					: undefined;
			const crossSessionRecovery =
				tool === "recover" &&
				recoveryContext !== undefined &&
				sessionId !== undefined &&
				recoveryContext.originSessionId !== sessionId;
			const externalRecoveryResources: string[] = [];
			if (tool === "recover" && recoveryContext !== undefined) {
				for (const recoveryPath of recoveryContext.paths) {
					try {
						await canonicalizeResource(recoveryPath, sandbox);
					} catch {
						try {
							externalRecoveryResources.push(
								await canonicalizeExternalPath(recoveryPath, sandbox.root)
							);
						} catch {
							return {
								errorText:
									"Recover target is outside the permitted filesystem scope.",
								kind: "deny",
							};
						}
					}
				}
			}
			const extraRecoveryChecks =
				tool === "recover"
					? [
							...externalRecoveryResources.map((resource) => ({
								action: "external_directory" as const,
								decision: permission.decide("external_directory", resource),
								resource,
							})),
							...(recoveryAction === "discard"
								? [
										{
											action: "recover:discard",
											decision: permission.decide(
												"recover:discard",
												gateResource.value
											),
											resource: gateResource.value,
										},
									]
								: []),
							...(crossSessionRecovery
								? [
										{
											action: "recover:cross-session",
											decision: permission.decide(
												"recover:cross-session",
												gateResource.value
											),
											resource: gateResource.value,
										},
									]
								: []),
						]
					: [];
			const settled = await settleApproval(
				{
					checks: [
						...limitChecks,
						{
							action,
							decision: permission.decide(action, gateResource.value),
							resource: gateResource.value,
						},
						...editModeChecks(gateResource.value),
						...extraRecoveryChecks,
					],
					doomAsk,
					request: requestFor(
						gateResource.value,
						externalRecoveryResources.length > 0,
						externalRecoveryResources.length > 0
							? externalRecoveryResources.join(", ")
							: undefined
					),
					safety: permission.safety,
				},
				approvalDeps,
				() =>
					grantApprovedAccess(() => {
						for (const resource of externalRecoveryResources) {
							service.grant(
								"external_directory",
								externalParentDirectoryGlob(resource)
							);
						}
						grantCodingAccess(gateResource.value);
						if (recoveryAction === "discard") {
							service.grant("recover:discard", gateResource.value);
						}
						if (crossSessionRecovery) {
							service.grant("recover:cross-session", gateResource.value);
						}
					})
			);
			const outcome = withErrorText(
				settled,
				staticDenialText(label, gateResource.value),
				(feedback) => staticRejectionText(label, gateResource.value, feedback)
			);
			return crossSessionRecovery && outcome.kind === "allow"
				? { ...outcome, approvedCrossSession: true }
				: outcome;
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
			// Grep and glob gate their operation against the search pattern; the
			// optional path only decides the external boundary. Other path tools
			// gate against the canonical path.
			const resource =
				gateResource.pattern ??
				(canonical === "" ? WORKSPACE_ROOT_RESOURCE : canonical);
			const settled = await settleApproval(
				{
					checks: [
						...limitChecks,
						{ action, decision: permission.decide(action, resource), resource },
						...editModeChecks(resource),
					],
					doomAsk,
					request: requestFor(resource, false),
					safety: permission.safety,
				},
				approvalDeps,
				() => grantApprovedAccess(() => grantCodingAccess(resource))
			);
			const outcome = withErrorText(
				settled,
				staticDenialText(label, gateResource.pattern ?? resource),
				(feedback) =>
					staticRejectionText(label, gateResource.pattern ?? resource, feedback)
			);
			if (outcome.kind !== "allow" || tool !== "edit") {
				return outcome;
			}
			const input = isPlainObject(toolCall.input) ? toolCall.input : {};
			const patch = Reflect.get(input, "patch");
			const approvedPath = path.resolve(sandbox.root, canonical);
			return isString(patch)
				? {
						...outcome,
						approvedWorkspacePaths: [approvedPath],
						input: {
							...input,
							patch: rewritePatchResourcePath(patch, approvedPath),
						},
					}
				: {
						...outcome,
						approvedWorkspacePaths: [approvedPath],
						input: { ...input, path: approvedPath },
					};
		} catch {
			// Glob results are workspace-relative, so an external scope cannot
			// produce a valid result. Deny it here instead of approving a call the
			// runner cannot execute inside the workspace.
			const externalPathInput = pathInput;
			if (tool === "glob") {
				return {
					errorText: `${label} path is outside the workspace: ${externalPathInput}`,
					kind: "deny",
				};
			}
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
						...limitChecks,
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
						...editModeChecks(gateResource.pattern ?? resource),
					],
					doomAsk,
					request: requestFor(
						gateResource.pattern ?? resource,
						true,
						isUndefined(gateResource.pattern) ? undefined : resource
					),
					safety: permission.safety,
				},
				approvalDeps,
				() =>
					grantApprovedAccess(() => {
						service.grant(
							"external_directory",
							externalParentDirectoryGlob(resource)
						);
						grantCodingAccess(gateResource.pattern ?? resource);
					})
			);
			const outcome = withErrorText(
				settled,
				staticDenialText(label, gateResource.pattern ?? resource),
				(feedback) =>
					staticRejectionText(label, gateResource.pattern ?? resource, feedback)
			);
			if (outcome.kind !== "allow" || !isUndefined(gateResource.pattern)) {
				return outcome;
			}
			const input = isPlainObject(toolCall.input)
				? toolCall.input
				: { path: resource };
			const patch = Reflect.get(input, "patch");
			if (tool === "edit" && isString(patch)) {
				return {
					...outcome,
					approvedExternalPaths: [resource],
					input: {
						...input,
						patch: rewritePatchResourcePath(patch, resource),
					},
				};
			}
			if (tool === "edit") {
				return {
					...outcome,
					approvedExternalPaths: [resource],
					input: { ...input, path: resource },
				};
			}
			return {
				...outcome,
				input: { ...input, path: resource },
			};
		}
	};
	/** Enforces the Tool Permission policy for a `shell` tool call (ADR-0008).
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
		toolCall: { input: unknown; toolCallId: ToolCallId },
		permission: ToolPermission,
		doomAsk: boolean,
		agentId?: AgentId
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
		const resourceLimits = await resolveResourceLimits(agentId);
		const limitChecks = resourceLimitChecks(resourceLimits);
		const cwd = getStringField(toolCall.input, "cwd");
		const request = async (external: boolean): Promise<ToolApprovalRequest> => {
			const warning = await recoveryWarning?.();
			return {
				description:
					warning === undefined
						? codingToolCatalog.shell.description
						: `${codingToolCatalog.shell.description}\n\n${warning}`,
				identity: [
					{ label: "tool", value: "shell" },
					{ label: "resource", value: command },
					...resourceLimitIdentity(resourceLimits),
					...(warning === undefined
						? []
						: [{ label: "recovery", value: warning }]),
					...(external ? [{ label: "scope", value: "external" }] : []),
				],
				input: toolCall.input,
				safety: permission.safety,
				toolCallId: toolCall.toolCallId,
			};
		};

		let externalResource: string | undefined;
		if (!isUndefined(cwd)) {
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

		if (isUndefined(externalResource)) {
			const settled = await settleApproval(
				{
					checks: [
						...limitChecks,
						{
							action: "shell",
							decision: operationDecision,
							resource: normalized,
						},
					],
					doomAsk,
					request: await request(false),
					safety: permission.safety,
				},
				approvalDeps,
				() =>
					grantResourceLimits(service, resourceLimits, () =>
						service.grant("shell", normalized)
					)
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
					...limitChecks,
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
				request: await request(true),
				safety: permission.safety,
			},
			approvalDeps,
			() =>
				grantResourceLimits(service, resourceLimits, () => {
					service.grant(
						"external_directory",
						externalParentDirectoryGlob(externalResource ?? "")
					);
					service.grant("shell", normalized);
				})
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
		const permission = await resolvePermission(call.agentId);
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

	// doom_loop (ADR-0008): per-session repeat tracking keyed by the
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
		if (call.family === "coding" && call.toolCall.toolName === "shell") {
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
			const permission = await resolvePermission(call.agentId);
			return gateShellToolCall(
				call.toolCall,
				permission,
				trackDoomLoop(call),
				call.agentId
			);
		}
		if (call.family === "coding") {
			const permission = await resolvePermission(call.agentId);
			return gateCodingToolCall(
				call.toolCall,
				permission,
				trackDoomLoop(call),
				call.agentId
			);
		}
		return { errorText: "Unknown tool authorization family", kind: "deny" };
	};

	return { gate };
};
