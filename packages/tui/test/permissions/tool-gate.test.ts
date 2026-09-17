import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import {
	getToolResourceLimits,
	type ToolResourceLimits,
} from "@wincode/coding-tools";
import { createWorkspaceSandbox } from "@wincode/coding-tools/workspace";
import { isUndefined } from "@wincode/runtime-utils";
import { mcpDeniedByPolicyText } from "@/modules/mcp/registry";
import {
	applyManualApprovalSafetyCeiling,
	canonicalizeExternalPath,
	createPermissionService,
	createToolPermission,
	externalParentDirectoryGlob,
	type PermissionService,
} from "@/modules/permissions";
import { createSessionEngine } from "@/modules/sessions/engine/session-engine";
import type {
	SessionApprovalOutcome,
	SessionEngine,
} from "@/modules/sessions/engine/types";
import {
	createToolGate,
	type ToolGateApprovalPort,
} from "@/modules/tool-gate/tool-gate";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import {
	toolCallId as makeToolCallId,
	sessionId,
} from "../support/identifiers";

const createGate = (
	permission = createToolPermission(),
	approvals: ToolGateApprovalPort = allowOnceApproval().approvals,
	onAbort?: Parameters<typeof createToolGate>[0]["onAbort"],
	service: PermissionService = createPermissionService(),
	resourceLimits: ToolResourceLimits = getToolResourceLimits()
) =>
	createToolGate({
		approvals,
		onAbort,
		resolvePermission: async () => permission,
		resolveResourceLimits: async () => resourceLimits,
		sandbox: createWorkspaceSandbox(process.cwd()),
		service,
	});

const shellCall = (
	command: string,
	toolCallId = "call-shell",
	cwd?: string
) => ({
	family: "shell" as const,
	toolCall: {
		input: isUndefined(cwd) ? { command } : { command, cwd },
		toolCallId: makeToolCallId(toolCallId),
	},
});

/** An approval port that records each request and settles it with `outcome`. */
const settlingApprovalPort = (
	outcome: SessionApprovalOutcome,
	requests?: ToolApprovalRequest[]
): ToolGateApprovalPort => ({
	request: (request) => {
		requests?.push(request);
		return Promise.resolve(outcome);
	},
});

/** An approval port that records each request and allows it once. */
const allowOnceApproval = (): {
	approvals: ToolGateApprovalPort;
	requests: ToolApprovalRequest[];
} => {
	const requests: ToolApprovalRequest[] = [];
	return {
		approvals: settlingApprovalPort(
			{ decision: "allow", remember: false },
			requests
		),
		requests,
	};
};

describe("shell posture defaults", () => {
	test("pwd, ls -la, and git status run without any approval", async () => {
		const { approvals, requests } = allowOnceApproval();
		const gate = createGate(createToolPermission(), approvals);

		for (const command of ["pwd", "ls -la", "git status"]) {
			await expect(gate.gate(shellCall(command))).resolves.toEqual({
				kind: "allow",
			});
		}
		expect(requests).toHaveLength(0);
	});
	test("asks once for an elevated profile and remembers its grant", async () => {
		const requests: ToolApprovalRequest[] = [];
		const service = createPermissionService();
		const gate = createGate(
			createToolPermission(),
			settlingApprovalPort({ decision: "allow", remember: true }, requests),
			undefined,
			service,
			getToolResourceLimits("extended")
		);

		await expect(gate.gate(shellCall("pwd"))).resolves.toEqual({
			kind: "allow",
		});
		await expect(gate.gate(shellCall("ls -la"))).resolves.toEqual({
			kind: "allow",
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]?.identity).toContainEqual({
			label: "limits",
			value: "extended resource profile",
		});
		expect(service.isGranted("resource_limits", "extended")).toBe(true);
	});

	test("rm and sudo are denied without an approval dialog", async () => {
		const { approvals, requests } = allowOnceApproval();
		const gate = createGate(createToolPermission(), approvals);

		await expect(gate.gate(shellCall("rm file.txt"))).resolves.toEqual({
			errorText: "Shell denied by policy: rm file.txt",
			kind: "deny",
		});
		await expect(gate.gate(shellCall("rm -rf src/"))).resolves.toEqual({
			errorText: "Shell denied by policy: rm -rf src/",
			kind: "deny",
		});
		await expect(gate.gate(shellCall("sudo npm install -g"))).resolves.toEqual({
			errorText: "Shell denied by policy: sudo npm install -g",
			kind: "deny",
		});
		expect(requests).toHaveLength(0);
	});

	test("compound commands deny on the rm node", async () => {
		const { approvals, requests } = allowOnceApproval();
		const gate = createGate(createToolPermission(), approvals);

		await expect(gate.gate(shellCall("cd ~ && rm -rf *"))).resolves.toEqual({
			errorText: "Shell denied by policy: cd ~ && rm -rf *",
			kind: "deny",
		});
		await expect(
			gate.gate(shellCall("git stash && rm -rf src/ 2>/dev/null"))
		).resolves.toEqual({
			errorText: "Shell denied by policy: git stash && rm -rf src/ 2>/dev/null",
			kind: "deny",
		});
		expect(requests).toHaveLength(0);
	});

	test("compound commands deny on the sudo node", async () => {
		const { approvals, requests } = allowOnceApproval();
		const gate = createGate(createToolPermission(), approvals);

		// `git status` alone is allowed, but the sudo node inside the compound
		// command carries its own deny and composes most-restrictively.
		await expect(
			gate.gate(shellCall("git status && sudo whoami"))
		).resolves.toEqual({
			errorText: "Shell denied by policy: git status && sudo whoami",
			kind: "deny",
		});
		expect(requests).toHaveLength(0);
	});

	test("a compound command with one ask node and one allow node prompts once and runs only on approval", async () => {
		const askPolicy = createToolPermission({ shell: { "git status": "ask" } });
		const { approvals, requests } = allowOnceApproval();
		const gate = createGate(askPolicy, approvals);

		// The ask node makes the whole compound an ask; the single approval
		// covers the call, and approving it runs the command.
		await expect(gate.gate(shellCall("git status && ls -la"))).resolves.toEqual(
			{
				kind: "allow",
			}
		);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.identity[1]).toEqual({
			label: "resource",
			value: "git status && ls -la",
		});

		// Rejecting that same ask never runs the command.
		const rejectingGate = createGate(
			askPolicy,
			settlingApprovalPort({ decision: "reject" })
		);
		await expect(
			rejectingGate.gate(shellCall("git status && ls -la"))
		).resolves.toEqual({
			errorText: "Shell was not approved: git status && ls -la",
			kind: "reject",
		});
	});

	test("a compound command with one deny node never prompts even when another node asks", async () => {
		const { approvals, requests } = allowOnceApproval();
		const gate = createGate(
			createToolPermission({ shell: { "ls *": "ask" } }),
			approvals
		);

		// The ask node would prompt on its own, but the rm node's deny composes
		// most-restrictively: no dialog opens and nothing runs.
		await expect(
			gate.gate(shellCall("ls -la && rm file.txt"))
		).resolves.toEqual({
			errorText: "Shell denied by policy: ls -la && rm file.txt",
			kind: "deny",
		});
		expect(requests).toHaveLength(0);
	});

	test("in a compound command only the cd node is exempt: the other node still evaluates", async () => {
		const { approvals, requests } = allowOnceApproval();
		const askGate = createGate(
			createToolPermission({ shell: { "git commit *": "ask" } }),
			approvals
		);

		// The cd node is exempt, but the git node's ask still prompts once for
		// the whole call and approval runs it.
		await expect(
			askGate.gate(shellCall("cd tmp && git commit -m x"))
		).resolves.toEqual({ kind: "allow" });
		expect(requests).toHaveLength(1);
		expect(requests[0]?.identity[1]).toEqual({
			label: "resource",
			value: "cd tmp && git commit -m x",
		});

		// A deny on the git node still denies the whole compound.
		const denyGate = createGate(
			createToolPermission({ shell: { "git *": "deny" } }),
			approvals
		);
		await expect(
			denyGate.gate(shellCall("cd tmp && git commit -m x"))
		).resolves.toEqual({
			errorText: "Shell denied by policy: cd tmp && git commit -m x",
			kind: "deny",
		});
		expect(requests).toHaveLength(1);

		// A rule targeting the cd node itself never prompts either: the node is
		// exempt inside compounds while the other node still evaluates.
		const cdAskGate = createGate(
			createToolPermission({ shell: { "cd tmp": "ask" } }),
			approvals
		);
		await expect(
			cdAskGate.gate(shellCall("cd tmp && ls -la"))
		).resolves.toEqual({ kind: "allow" });
		expect(requests).toHaveLength(1);
	});

	test("cd-family commands are exempt from the shell ask", async () => {
		const { approvals, requests } = allowOnceApproval();
		const gate = createGate(createToolPermission(), approvals);

		for (const command of ["cd ~", "cd packages/tui", "pushd /tmp", "popd"]) {
			await expect(gate.gate(shellCall(command))).resolves.toEqual({
				kind: "allow",
			});
		}
		expect(requests).toHaveLength(0);
	});

	test("cd-family commands stay exempt under an ask policy but an explicit deny still holds", async () => {
		const { approvals, requests } = allowOnceApproval();
		const askGate = createGate(
			createToolPermission({ shell: "ask" }),
			approvals
		);
		for (const command of [
			"cd packages/tui",
			"chdir src",
			"push-location src",
			"pushd src",
			"popd",
			"set-location src",
		]) {
			await expect(askGate.gate(shellCall(command))).resolves.toEqual({
				kind: "allow",
			});
		}
		expect(requests).toHaveLength(0);

		const denyGate = createGate(
			createToolPermission({ shell: "deny" }),
			approvals
		);
		await expect(denyGate.gate(shellCall("cd ~"))).resolves.toEqual({
			errorText: "Shell denied by policy: cd ~",
			kind: "deny",
		});
	});

	test("a command without any command node still honors explicit shell rules", async () => {
		const { approvals, requests } = allowOnceApproval();
		const denyGate = createGate(
			createToolPermission({ shell: "deny" }),
			approvals
		);
		// A bare assignment parses cleanly with no command node; an explicit
		// deny must still block it (and never silently allow it).
		await expect(denyGate.gate(shellCall("FOO=bar"))).resolves.toEqual({
			errorText: "Shell denied by policy: FOO=bar",
			kind: "deny",
		});

		const askGate = createGate(
			createToolPermission({ shell: "ask" }),
			approvals
		);
		await expect(askGate.gate(shellCall("FOO=bar"))).resolves.toEqual({
			kind: "allow",
		});
		expect(requests).toHaveLength(1);

		const defaultGate = createGate(createToolPermission(), approvals);
		await expect(defaultGate.gate(shellCall("FOO=bar"))).resolves.toEqual({
			kind: "allow",
		});
	});

	test("an unparseable command fails closed to an ask", async () => {
		const { approvals, requests } = allowOnceApproval();
		const gate = createGate(createToolPermission(), approvals);

		await expect(gate.gate(shellCall('echo "unterminated'))).resolves.toEqual({
			kind: "allow",
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.identity[1]).toEqual({
			label: "resource",
			value: 'echo "unterminated',
		});
	});
});

describe("shell override and grants", () => {
	test("a configured rm * ask turns rm into an ordinary ask where allow-once and always work", async () => {
		const { approvals, requests } = allowOnceApproval();
		const gate = createGate(
			createToolPermission({ shell: { "rm *": "ask" } }),
			approvals
		);

		await expect(gate.gate(shellCall("rm file.txt"))).resolves.toEqual({
			kind: "allow",
		});
		expect(requests).toHaveLength(1);
		// The shipped sudo deny stays in force under the override.
		await expect(gate.gate(shellCall("sudo npm install -g"))).resolves.toEqual({
			errorText: "Shell denied by policy: sudo npm install -g",
			kind: "deny",
		});

		// An always approval on the override path records the exact command and
		// satisfies only an identical repeat.
		const service = createPermissionService();
		const alwaysRequests: ToolApprovalRequest[] = [];
		const alwaysGate = createToolGate({
			approvals: settlingApprovalPort(
				{ decision: "allow", remember: true },
				alwaysRequests
			),
			resolvePermission: async () =>
				createToolPermission({ shell: { "rm *": "ask" } }),
			sandbox: createWorkspaceSandbox(process.cwd()),
			service,
		});
		await alwaysGate.gate(shellCall("rm file.txt", "call-always-1"));
		expect(service.isGranted("shell", "rm file.txt")).toBe(true);
		await alwaysGate.gate(shellCall("rm file.txt", "call-always-2"));
		expect(alwaysRequests).toHaveLength(1);
		// A sibling rm command is not covered by the exact grant.
		await alwaysGate.gate(shellCall("rm other.txt", "call-always-3"));
		expect(alwaysRequests).toHaveLength(2);
	});

	test("always approval records the exact normalized command", async () => {
		const service = createPermissionService();
		const requests: ToolApprovalRequest[] = [];
		const gate = createToolGate({
			approvals: settlingApprovalPort(
				{ decision: "allow", remember: true },
				requests
			),
			resolvePermission: async () =>
				createToolPermission({ shell: { "*": "ask" } }),
			sandbox: createWorkspaceSandbox(process.cwd()),
			service,
		});

		await expect(gate.gate(shellCall("git commit -m init"))).resolves.toEqual({
			kind: "allow",
		});
		expect(service.isGranted("shell", "git commit -m init")).toBe(true);
		expect(service.isGranted("shell", "*")).toBe(false);

		// An identical subsequent command is satisfied by the grant; a sibling
		// command still asks.
		await expect(
			gate.gate(shellCall("git commit -m init", "call-grant-repeat"))
		).resolves.toEqual({ kind: "allow" });
		expect(requests).toHaveLength(1);
		await expect(
			gate.gate(shellCall("git status", "call-grant-sibling"))
		).resolves.toEqual({ kind: "allow" });
		expect(requests).toHaveLength(2);
		// A sibling with the same command word and different arguments is not
		// covered by the exact grant either.
		await expect(
			gate.gate(shellCall("git commit -m wip", "call-grant-sibling-wip"))
		).resolves.toEqual({ kind: "allow" });
		expect(requests).toHaveLength(3);
	});

	test("revoking a shell exact grant makes the identical command prompt again", async () => {
		const service = createPermissionService();
		const requests: ToolApprovalRequest[] = [];
		const gate = createToolGate({
			approvals: settlingApprovalPort(
				{ decision: "allow", remember: true },
				requests
			),
			resolvePermission: async () =>
				createToolPermission({ shell: { "*": "ask" } }),
			sandbox: createWorkspaceSandbox(process.cwd()),
			service,
		});

		await gate.gate(shellCall("git commit -m init", "call-grant-1"));
		expect(service.listGrants()).toEqual([
			{ action: "shell", resource: "git commit -m init" },
		]);
		// The grant satisfies the identical command without prompting.
		await gate.gate(shellCall("git commit -m init", "call-grant-2"));
		expect(requests).toHaveLength(1);

		// Revoking the grant (as /permissions does) makes it prompt again. A
		// differing call first resets the doom_loop counter so the observed ask
		// is solely the revoked policy ask.
		await gate.gate(shellCall("git status", "call-interrupt"));
		service.revoke("shell", "git commit -m init");
		await gate.gate(shellCall("git commit -m init", "call-revoked"));
		expect(requests).toHaveLength(3);
	});

	test("a shell exact grant never satisfies another tool family", async () => {
		const service = createPermissionService();
		const requests: ToolApprovalRequest[] = [];
		const gate = createToolGate({
			approvals: settlingApprovalPort(
				{ decision: "allow", remember: false },
				requests
			),
			resolvePermission: async () => createToolPermission({ read: "ask" }),
			sandbox: createWorkspaceSandbox(process.cwd()),
			service,
		});

		service.grant("shell", "git commit -m init");
		// The shell grant does not leak: the read-family call still asks.
		await expect(
			gate.gate({
				family: "coding",
				toolCall: {
					input: { path: "package.json" },
					toolCallId: makeToolCallId("call-read"),
					toolName: "read",
				},
			})
		).resolves.toEqual({ kind: "allow" });
		expect(requests).toHaveLength(1);
	});
	test("gates a ranged read against its base file", async () => {
		const gate = createGate(
			createToolPermission({ read: { "**": "allow", "package.json": "deny" } })
		);

		await expect(
			gate.gate({
				family: "coding",
				toolCall: {
					input: { path: "package.json:1-2" },
					toolCallId: makeToolCallId("call-ranged-read"),
					toolName: "read",
				},
			})
		).resolves.toEqual({
			errorText: "Read denied by policy: package.json",
			kind: "deny",
		});
	});
	test("a write approval does not grant the elevated resource profile", async () => {
		const service = createPermissionService();
		const requests: ToolApprovalRequest[] = [];
		const gate = createGate(
			createToolPermission({ edit: "ask" }),
			settlingApprovalPort({ decision: "allow", remember: true }, requests),
			undefined,
			service,
			getToolResourceLimits("extended")
		);

		await expect(
			gate.gate({
				family: "coding",
				toolCall: {
					input: { content: "updated", path: "notes.txt" },
					toolCallId: makeToolCallId("call-write"),
					toolName: "write",
				},
			})
		).resolves.toEqual({ kind: "allow" });
		expect(requests).toHaveLength(1);
		expect(service.isGranted("resource_limits", "extended")).toBe(false);
	});

	test("an explicit deny is never bypassed by grants or auto approval", async () => {
		const service = createPermissionService({ autoApproval: true });
		service.grant("shell", "rm -rf src/");
		const { approvals, requests } = allowOnceApproval();
		const gate = createGate(
			createToolPermission(),
			approvals,
			undefined,
			service
		);

		await expect(gate.gate(shellCall("rm -rf src/"))).resolves.toEqual({
			errorText: "Shell denied by policy: rm -rf src/",
			kind: "deny",
		});
		expect(requests).toHaveLength(0);
	});

	test("an external cwd composes the external-directory ask and grants the exact command", async () => {
		const parent = await mkdtemp(
			join(process.env.TMPDIR ?? "/tmp", "wincode-gate-")
		);
		const workspace = join(parent, "workspace");
		await mkdir(workspace);
		const service = createPermissionService();
		const requests: ToolApprovalRequest[] = [];
		const gate = createToolGate({
			approvals: settlingApprovalPort(
				{ decision: "allow", remember: true },
				requests
			),
			resolvePermission: async () => createToolPermission(),
			sandbox: createWorkspaceSandbox(workspace),
			service,
		});

		await expect(
			gate.gate(shellCall("pwd", "call-shell-external", "../outside"))
		).resolves.toEqual({ kind: "allow" });
		expect(requests).toHaveLength(1);
		expect(requests[0]?.identity[2]).toEqual({
			label: "scope",
			value: "external",
		});
		expect(service.isGranted("shell", "pwd")).toBe(true);
		expect(service.isGranted("shell", "*")).toBe(false);
		const resource = await canonicalizeExternalPath("../outside", workspace);
		expect(service.isGranted("external_directory", resource)).toBe(true);
	});

	test("a cd-family command with an external cwd still composes the external-directory ask", async () => {
		const parent = await mkdtemp(
			join(process.env.TMPDIR ?? "/tmp", "wincode-gate-")
		);
		const workspace = join(parent, "workspace");
		await mkdir(workspace);
		const service = createPermissionService();
		const requests: ToolApprovalRequest[] = [];
		const gate = createToolGate({
			approvals: settlingApprovalPort(
				{ decision: "allow", remember: true },
				requests
			),
			resolvePermission: async () => createToolPermission(),
			sandbox: createWorkspaceSandbox(workspace),
			service,
		});

		// cd skips the shell ask entirely, but the cwd outside the workspace
		// still composes the external_directory boundary ask on the call.
		await expect(
			gate.gate(
				shellCall("cd ~/projects/other", "call-shell-cd-external", "../outside")
			)
		).resolves.toEqual({ kind: "allow" });
		expect(requests).toHaveLength(1);
		expect(requests[0]?.identity.map(({ label }) => label)).toEqual([
			"tool",
			"resource",
			"scope",
		]);
		expect(requests[0]?.identity[2]).toEqual({
			label: "scope",
			value: "external",
		});
		const resource = await canonicalizeExternalPath("../outside", workspace);
		expect(service.isGranted("external_directory", resource)).toBe(true);
		expect(service.isGranted("shell", "cd ~/projects/other")).toBe(true);
	});

	test("a workspace-internal cwd gates without the external scope", async () => {
		const { approvals, requests } = allowOnceApproval();
		const gate = createGate(
			createToolPermission({ shell: { "*": "ask" } }),
			approvals
		);

		await expect(
			gate.gate(shellCall("pwd", "call-shell-inside", "packages/tui"))
		).resolves.toEqual({ kind: "allow" });
		expect(requests).toHaveLength(1);
		expect(requests[0]?.identity.map(({ label }) => label)).toEqual([
			"tool",
			"resource",
		]);
	});
});

describe("doom_loop", () => {
	test("the third identical shell call asks and a differing call resets the run", async () => {
		const { approvals, requests } = allowOnceApproval();
		const gate = createGate(createToolPermission(), approvals);

		await gate.gate(shellCall("pwd", "call-1"));
		await gate.gate(shellCall("pwd", "call-2"));
		// A differing call resets the repeat run.
		await gate.gate(shellCall("ls -la", "call-3"));
		await gate.gate(shellCall("pwd", "call-4"));
		await gate.gate(shellCall("pwd", "call-5"));
		// The third consecutive pwd is an ordinary ask, allow-once runs it.
		await expect(gate.gate(shellCall("pwd", "call-6"))).resolves.toEqual({
			kind: "allow",
		});
		expect(requests).toHaveLength(1);
	});

	test("--auto bypasses the doom_loop ask but an explicit deny never does", async () => {
		const service = createPermissionService({ autoApproval: true });
		const { approvals, requests } = allowOnceApproval();
		const gate = createGate(
			createToolPermission(),
			approvals,
			undefined,
			service
		);

		await gate.gate(shellCall("pwd", "call-1"));
		await gate.gate(shellCall("pwd", "call-2"));
		await expect(gate.gate(shellCall("pwd", "call-3"))).resolves.toEqual({
			kind: "allow",
		});
		expect(requests).toHaveLength(0);

		await gate.gate(shellCall("rm file.txt", "call-4"));
		await gate.gate(shellCall("rm file.txt", "call-5"));
		await expect(
			gate.gate(shellCall("rm file.txt", "call-6"))
		).resolves.toEqual({
			errorText: "Shell denied by policy: rm file.txt",
			kind: "deny",
		});
		expect(requests).toHaveLength(0);
	});

	test("doom_loop applies to coding tools too", async () => {
		const { approvals, requests } = allowOnceApproval();
		const gate = createGate(createToolPermission(), approvals);

		const readCall = (toolCallId: string) => ({
			family: "coding" as const,
			toolCall: {
				input: { path: "package.json" },
				toolCallId: makeToolCallId(toolCallId),
				toolName: "read",
			},
		});
		await gate.gate(readCall("call-1"));
		await gate.gate(readCall("call-2"));
		await expect(gate.gate(readCall("call-3"))).resolves.toEqual({
			kind: "allow",
		});
		expect(requests).toHaveLength(1);
	});

	test("doom_loop applies to MCP tools and a differing input resets the run", async () => {
		const { approvals, requests } = allowOnceApproval();
		const gate = createGate(createToolPermission(), approvals);
		const mcpCall = (text: string, toolCallId: string) => ({
			action: "demo_echo",
			agentDecision: "allow" as const,
			description: "Echo",
			family: "mcp" as const,
			input: { text },
			safety: false,
			serverDecision: "allow" as const,
			toolCallId: makeToolCallId(toolCallId),
			toolName: "mcp_demo_echo",
		});
		await gate.gate(mcpCall("hello", "call-1"));
		await gate.gate(mcpCall("hello", "call-2"));
		// A differing input resets the run.
		await gate.gate(mcpCall("other", "call-3"));
		await gate.gate(mcpCall("hello", "call-4"));
		await gate.gate(mcpCall("hello", "call-5"));
		// The third identical echo is an ordinary ask, allow-once runs it.
		await expect(gate.gate(mcpCall("hello", "call-6"))).resolves.toEqual({
			kind: "allow",
		});
		expect(requests).toHaveLength(1);
	});

	test("a differing family or tool resets the doom run", async () => {
		const { approvals, requests } = allowOnceApproval();
		const gate = createGate(createToolPermission(), approvals);

		const mcpCall = (toolCallId: string) => ({
			action: "demo_echo",
			agentDecision: "allow" as const,
			description: "Echo",
			family: "mcp" as const,
			input: { text: "hello" },
			safety: false,
			serverDecision: "allow" as const,
			toolCallId: makeToolCallId(toolCallId),
			toolName: "mcp_demo_echo",
		});
		const readCall = (toolCallId: string) => ({
			family: "coding" as const,
			toolCall: {
				input: { path: "package.json" },
				toolCallId: makeToolCallId(toolCallId),
				toolName: "read",
			},
		});

		await gate.gate(shellCall("pwd", "call-1"));
		await gate.gate(shellCall("pwd", "call-2"));
		// An MCP call is a different family and resets the repeat run.
		await gate.gate(mcpCall("call-3"));
		// A coding tool call is a different tool and resets the run again.
		await gate.gate(readCall("call-4"));
		await gate.gate(readCall("call-5"));
		// The third consecutive read call is an ordinary ask.
		await expect(gate.gate(readCall("call-6"))).resolves.toEqual({
			kind: "allow",
		});
		expect(requests).toHaveLength(1);
	});
});

describe("shell manual safety ceiling", () => {
	test("the manual ceiling still forces an ask that grants never bypass", async () => {
		const service = createPermissionService();
		service.grant("shell", "git status");
		const requests: ToolApprovalRequest[] = [];
		const permission = applyManualApprovalSafetyCeiling(createToolPermission());
		const gate = createToolGate({
			approvals: settlingApprovalPort(
				{ decision: "allow", remember: true },
				requests
			),
			resolvePermission: async () => permission,
			sandbox: createWorkspaceSandbox(process.cwd()),
			service,
		});

		await expect(
			gate.gate(shellCall("git status", "call-safety"))
		).resolves.toEqual({ kind: "allow" });
		expect(requests).toHaveLength(1);
		expect(requests[0]?.safety).toBe(true);
		// The manual-only ask records no new grant, so the next call asks again.
		await expect(
			gate.gate(shellCall("git status", "call-safety-2"))
		).resolves.toEqual({ kind: "allow" });
		expect(requests).toHaveLength(2);
		expect(service.listGrants()).toEqual([
			{ action: "shell", resource: "git status" },
		]);
	});
});

test("coding-family calls route shell and reject unknown tools", async () => {
	const gate = createGate();

	await expect(
		gate.gate({
			family: "coding",
			toolCall: {
				input: {},
				toolCallId: makeToolCallId("call-shell"),
				toolName: "shell",
			},
		})
	).resolves.toEqual({
		kind: "allow",
	});
	await expect(
		gate.gate({
			family: "coding",
			toolCall: {
				input: {},
				toolCallId: makeToolCallId("call-unknown"),
				toolName: "unknown",
			},
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
	const requests: ToolApprovalRequest[] = [];
	const gate = createGate(
		createToolPermission({ skill: "ask" }),
		settlingApprovalPort({ decision: "allow", remember: false }, requests)
	);

	await expect(
		gate.gate({
			available: false,
			description: "Activate missing",
			family: "skill",
			name: "missing",
		})
	).resolves.toEqual({ kind: "allow" });
	expect(requests).toHaveLength(0);
});

test("MCP policy and safety are composed inside the gate", async () => {
	const requests: ToolApprovalRequest[] = [];
	const gate = createGate(
		createToolPermission(),
		settlingApprovalPort({ decision: "allow", remember: false }, requests)
	);

	await expect(
		gate.gate({
			action: "demo_echo",
			agentDecision: "allow",
			description: "Echo",
			family: "mcp",
			input: {},
			safety: true,
			serverDecision: "allow",
			toolCallId: makeToolCallId("call-mcp"),
			toolName: "mcp_demo_echo",
		})
	).resolves.toEqual({ kind: "allow" });
	expect(requests).toHaveLength(1);
});

test("rejects one approval without notifying the session abort path", async () => {
	let abortCount = 0;
	const gate = createGate(
		createToolPermission(),
		settlingApprovalPort({ decision: "reject" }),
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
			toolCallId: makeToolCallId("call-rejected"),
			toolName: "mcp_demo_echo",
		})
	).resolves.toEqual({
		errorText: "MCP tool 'mcp_demo_echo' was not approved",
		kind: "reject",
	});
	expect(abortCount).toBe(0);
});

test("abort notifies the session with the active tool call", async () => {
	let abortedToolCallId: string | undefined;
	const gate = createGate(
		createToolPermission(),
		settlingApprovalPort({ decision: "abort" }),
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
			toolCallId: makeToolCallId("call-aborted"),
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
		settlingApprovalPort({ decision: "abort" }),
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
			toolCallId: makeToolCallId("call-mcp"),
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
		approvals: settlingApprovalPort(
			{ decision: "allow", remember: false },
			requests
		),
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
				toolCallId: makeToolCallId("call-external-operation"),
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

describe("approval settlement through the Session Engine", () => {
	const createEngine = () =>
		createSessionEngine({
			compaction: {
				// Compaction is not part of this seam; the Engine only needs the port.
				compact: () =>
					Promise.reject(new Error("Compaction is unavailable in this test.")),
				getInFlight: () => null,
			},
			initialTranscript: [],
			sessionId: sessionId("gate-approval"),
		});

	const askGate = (engine: SessionEngine) =>
		createToolGate({
			approvals: { request: engine.requestApproval },
			resolvePermission: async () =>
				createToolPermission({ shell: { "git status": "ask" } }),
			sandbox: createWorkspaceSandbox(process.cwd()),
			service: createPermissionService(),
		});

	/** The gate registers its request after its own asynchronous resolution. */
	const whenApprovalRequested = async (
		engine: SessionEngine
	): Promise<void> => {
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if (engine.getSnapshot().approvals.length > 0) {
				return;
			}
			await Promise.resolve();
		}
		throw new Error("The Tool Gate never requested an approval.");
	};

	test("closing approvals settles the waiting Tool Gate evaluation", async () => {
		const engine = createEngine();
		const gate = askGate(engine);
		const evaluation = gate.gate(shellCall("git status", "call-close"));
		await whenApprovalRequested(engine);

		engine.closeApprovals();

		await expect(evaluation).resolves.toEqual({
			errorText: "Shell was not approved: git status",
			feedback: undefined,
			kind: "reject",
		});
		expect(engine.getSnapshot().approvals[0]?.decision).toEqual({
			decision: "reject",
		});
	});

	test("notifies the abort path once when two triggers abort the same request", async () => {
		const engine = createEngine();
		let abortCount = 0;
		const gate = createToolGate({
			approvals: { request: engine.requestApproval },
			onAbort: () => {
				abortCount += 1;
			},
			resolvePermission: async () =>
				createToolPermission({ shell: { "git status": "ask" } }),
			sandbox: createWorkspaceSandbox(process.cwd()),
			service: createPermissionService(),
		});
		const evaluation = gate.gate(shellCall("git status", "call-abort-twice"));
		await whenApprovalRequested(engine);

		// Two abort triggers for the one request: the settlement is the only
		// route, so the second one cannot handle the abort again.
		engine.respondToApproval("call-abort-twice", { decision: "abort" });
		engine.respondToApproval("call-abort-twice", { decision: "abort" });

		await expect(evaluation).resolves.toMatchObject({ kind: "reject" });
		expect(abortCount).toBe(1);
	});

	test("shutting the session down settles the waiting Tool Gate evaluation", async () => {
		const engine = createEngine();
		const gate = askGate(engine);
		const evaluation = gate.gate(shellCall("git status", "call-shutdown"));
		await whenApprovalRequested(engine);

		engine.shutdown();

		await expect(evaluation).resolves.toEqual({
			errorText: "Shell was not approved: git status",
			feedback: undefined,
			kind: "reject",
		});
	});
});
