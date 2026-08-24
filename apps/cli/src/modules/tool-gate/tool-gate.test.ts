import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspaceSandbox } from "@wincode/ai/workspace";
import { mcpDeniedByPolicyText } from "@/modules/mcp/registry";
import {
	canonicalizeExternalPath,
	createPermissionService,
	createToolPermission,
	externalParentDirectoryGlob,
} from "@/modules/permissions";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import { createToolGate } from "./tool-gate";

const createGate = (
	permission = createToolPermission(),
	openApproval: Parameters<typeof createToolGate>[0]["openApproval"] = () =>
		undefined,
	onAbort?: Parameters<typeof createToolGate>[0]["onAbort"]
) =>
	createToolGate({
		onAbort,
		openApproval,
		resolvePermission: async () => permission,
		sandbox: createWorkspaceSandbox(process.cwd()),
		service: createPermissionService(),
	});

test("coding-family calls fail closed for shell and unknown tools", async () => {
	const gate = createGate();

	await expect(
		gate.gate({
			family: "coding",
			toolCall: { input: {}, toolCallId: "call-shell", toolName: "shell" },
		})
	).resolves.toEqual({
		errorText: "Shell tool call used the coding authorization family",
		kind: "deny",
	});
	await expect(
		gate.gate({
			family: "coding",
			toolCall: { input: {}, toolCallId: "call-unknown", toolName: "unknown" },
		})
	).resolves.toEqual({
		errorText: "Unknown coding tool 'unknown'",
		kind: "deny",
	});
});

test("unknown authorization families fail closed at the runtime boundary", async () => {
	const gate = createGate();

	await expect(
		Reflect.apply(gate.gate, gate, [{ family: "unknown" }])
	).resolves.toEqual({
		errorText: "Unknown tool authorization family",
		kind: "deny",
	});
});

test("an unavailable ask-gated Skill does not open approval", async () => {
	let approvalCount = 0;
	const gate = createGate(createToolPermission({ skill: "ask" }), () => {
		approvalCount += 1;
	});

	await expect(
		gate.gate({
			available: false,
			description: "Activate missing",
			family: "skill",
			name: "missing",
		})
	).resolves.toEqual({ kind: "allow" });
	expect(approvalCount).toBe(0);
});

test("MCP policy and safety are composed inside the gate", async () => {
	let approvalCount = 0;
	const gate = createGate(createToolPermission(), (_request, actions) => {
		approvalCount += 1;
		actions.allow(false);
	});

	await expect(
		gate.gate({
			action: "demo_echo",
			agentDecision: "allow",
			description: "Echo",
			family: "mcp",
			input: {},
			safety: true,
			serverDecision: "allow",
			toolCallId: "call-mcp",
			toolName: "mcp_demo_echo",
		})
	).resolves.toEqual({ kind: "allow" });
	expect(approvalCount).toBe(1);
});

test("rejects one approval without notifying the conversation abort path", async () => {
	let abortCount = 0;
	const gate = createGate(
		createToolPermission(),
		(_request, actions) => actions.reject(),
		() => {
			abortCount += 1;
		}
	);

	await expect(
		gate.gate({
			action: "demo_echo",
			agentDecision: "ask",
			description: "Echo",
			family: "mcp",
			input: {},
			safety: false,
			serverDecision: "allow",
			toolCallId: "call-rejected",
			toolName: "mcp_demo_echo",
		})
	).resolves.toEqual({
		errorText: "MCP tool 'mcp_demo_echo' was not approved",
		kind: "reject",
	});
	expect(abortCount).toBe(0);
});

test("abort notifies the conversation with the active tool call", async () => {
	let abortedToolCallId: string | undefined;
	const gate = createGate(
		createToolPermission(),
		(_request, actions) => actions.abort(),
		(request) => {
			abortedToolCallId = request.toolCallId;
		}
	);

	await expect(
		gate.gate({
			action: "demo_echo",
			agentDecision: "ask",
			description: "Echo",
			family: "mcp",
			input: {},
			safety: false,
			serverDecision: "allow",
			toolCallId: "call-aborted",
			toolName: "mcp_demo_echo",
		})
	).resolves.toEqual({
		errorText: "MCP tool 'mcp_demo_echo' was not approved",
		kind: "reject",
	});
	expect(abortedToolCallId).toBe("call-aborted");
});

test("identifies an explicit Skill abort without an in-flight tool call", async () => {
	let abortedToolCallId: string | undefined = "unexpected";
	const gate = createGate(
		createToolPermission({ skill: "ask" }),
		(_request, actions) => actions.abort(),
		(request) => {
			abortedToolCallId = request.toolCallId;
		}
	);

	await expect(
		gate.gate({
			available: true,
			description: "Activate demo",
			family: "skill",
			name: "demo",
		})
	).resolves.toEqual({
		errorText: 'Skill "demo" was not approved',
		kind: "reject",
	});
	expect(abortedToolCallId).toBeUndefined();
});

test("MCP denial wording is the shared registry constant", async () => {
	const gate = createGate(createToolPermission());

	await expect(
		gate.gate({
			action: "demo_echo",
			agentDecision: "deny",
			description: "Echo",
			family: "mcp",
			input: {},
			safety: false,
			serverDecision: "deny",
			toolCallId: "call-mcp",
			toolName: "mcp_demo_echo",
		})
	).resolves.toEqual({
		errorText: mcpDeniedByPolicyText("mcp_demo_echo"),
		kind: "deny",
	});
});

test("an external-directory grant does not satisfy an operation ask", async () => {
	const parent = await mkdtemp(
		join(process.env.TMPDIR ?? "/tmp", "wincode-gate-")
	);
	const workspace = join(parent, "workspace");
	const outside = join(parent, "outside");
	await mkdir(workspace);
	await mkdir(outside);
	const resource = await canonicalizeExternalPath(
		"../outside/file.txt",
		workspace
	);
	const service = createPermissionService();
	service.grant("external_directory", externalParentDirectoryGlob(resource));
	const requests: ToolApprovalRequest[] = [];
	const gate = createToolGate({
		openApproval: (request, actions) => {
			requests.push(request);
			actions.allow(false);
		},
		resolvePermission: async () =>
			createToolPermission({
				external_directory: "allow",
				read: "ask",
			}),
		sandbox: createWorkspaceSandbox(workspace),
		service,
	});

	await expect(
		gate.gate({
			family: "coding",
			toolCall: {
				input: { path: "../outside/file.txt" },
				toolCallId: "call-external-operation",
				toolName: "read",
			},
		})
	).resolves.toEqual({
		input: { path: resource },
		kind: "allow",
	});
	// The call still reaches the approval panel because only the boundary was
	// granted; the operation itself remained ask-gated.
	expect(requests).toHaveLength(1);
});
