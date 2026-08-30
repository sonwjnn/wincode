/**
 * Smoke scenario for the list removal cutover (#45), driven through the real
 * CLI coding-tool pipeline: the CLI's chat tool-call dispatcher
 * (createChatToolCallHandler), the real Tool Gate, the real permission
 * service, and the real @wincode/ai runners, with model tool calls scripted
 * exactly as the AI SDK would emit them. Demonstrates glob path discovery,
 * directory Read Tool continuation, unchanged grep content search, and the
 * stale `list` failure mode.
 *
 * Run: bun run scripts/smoke-discovery-cutover.ts (from apps/cli)
 *
 * The coding-tool runners resolve paths against the workspace rooted at the
 * process working directory at module load, so the sandbox workspace is
 * created and entered before any @wincode/ai import.
 */
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspace = mkdtempSync(join(tmpdir(), "wincode-smoke-"));
mkdirSync(join(workspace, "src", "nested"), { recursive: true });
mkdirSync(join(workspace, "node_modules", "pkg"), { recursive: true });
mkdirSync(join(workspace, ".git", "objects"), { recursive: true });
writeFileSync(join(workspace, "src", "alpha.ts"), "needle alpha\n");
writeFileSync(join(workspace, "src", "nested", "beta.ts"), "needle beta\n");
writeFileSync(join(workspace, "src", "gamma.txt"), "gamma\n");
writeFileSync(join(workspace, "node_modules", "pkg", "index.js"), "ignored\n");
writeFileSync(join(workspace, ".git", "objects", "secret"), "secret\n");
writeFileSync(join(workspace, ".gitignore"), "node_modules/\n");
// Deterministic ordering: gamma.txt newest, alpha.ts next, beta.ts oldest.
utimesSync(join(workspace, "src", "gamma.txt"), 3000, 3000);
utimesSync(join(workspace, "src", "alpha.ts"), 2000, 2000);
utimesSync(join(workspace, "src", "nested", "beta.ts"), 1000, 1000);

// The CLI runs with the workspace as its working directory and the coding-tool
// runners resolve relative paths against the workspace root captured at load.
process.chdir(workspace);

const { handleCodingAgentToolCall } = await import("@wincode/ai/client");
const { createWorkspaceSandbox } = await import("@wincode/ai/workspace");
const { buildAgent, planAgent } = await import("@wincode/ai");
const { createApprovalQueue } = await import(
	"../src/shared/providers/approval/approval-queue"
);
const { createPermissionService, createToolPermission } = await import(
	"../src/modules/permissions"
);
const { createToolGate } = await import("../src/modules/tool-gate/tool-gate");
const { createChatToolCallHandler } = await import(
	"../src/modules/conversations/hooks/tool-dispatch"
);
const { configuredAgentVisibleCodingTools } = await import(
	"../src/modules/agents/registry"
);

type ToolOutput = {
	errorText?: string;
	output?: unknown;
	state?: "output-error";
	tool: string;
	toolCallId: string;
};

const sandbox = createWorkspaceSandbox(workspace);
const permission = createToolPermission();
const service = createPermissionService({ autoApproval: true });
const gate = createToolGate({
	approvalQueue: createApprovalQueue(),
	openApproval: (_request, actions) => actions.allow(true),
	resolvePermission: async () => permission,
	sandbox,
	service,
});

const outputs: ToolOutput[] = [];
const addToolOutputRef = {
	current: null as null | ((output: ToolOutput) => void),
};
addToolOutputRef.current = (output) => {
	outputs.push(output);
};
const resolvedAgentRef = {
	current: {
		instructions: buildAgent.instructions,
		visibleCodingTools: buildAgent.visibleCodingTools,
	},
};
const handler = createChatToolCallHandler({
	addToolOutputRef: addToolOutputRef as never,
	dynamicToolOutputRef: { current: null } as never,
	handleCodingAgentToolCall,
	mcp: { handleDynamicToolCall: async () => undefined } as never,
	mcpSnapshotRef: { current: null } as never,
	resolvedAgentRef: resolvedAgentRef as never,
	gate,
});

const settle = async (count: number) => {
	for (let attempt = 0; attempt < 500 && outputs.length < count; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

const run = (toolCall: {
	dynamic?: boolean;
	input: unknown;
	toolName: string;
	toolCallId: string;
}) => {
	handler({
		addToolOutput: addToolOutputRef.current ?? (() => undefined),
		toolCall,
	} as never);
};

const section = (title: string) => {
	console.log(`\n=== ${title} ===`);
};

console.log("Workspace:", workspace);
console.log("Agent-visible coding tools:");
console.log("  build:", buildAgent.visibleCodingTools.join(", "));
console.log("  plan: ", planAgent.visibleCodingTools.join(", "));
console.log("  configured:", configuredAgentVisibleCodingTools.join(", "));
console.log(
	"  list absent from every agent manifest:",
	!(
		[
			...buildAgent.visibleCodingTools,
			...planAgent.visibleCodingTools,
			...configuredAgentVisibleCodingTools,
		] as string[]
	).includes("list")
);

section(
	"1. glob path discovery (scoped, gitignore-aware, .git pruned, mtime-ordered)"
);
run({
	input: { path: "src", pattern: "**/*.ts" },
	toolCallId: "call-glob-1",
	toolName: "glob",
});
await settle(1);
console.log(JSON.stringify(outputs.at(-1), null, 2));

section("2. Read Tool directory tree with Line Range Selector continuation");
run({ input: { path: "src" }, toolCallId: "call-read-1", toolName: "read" });
await settle(2);
console.log(JSON.stringify(outputs.at(-1), null, 2));

run({
	input: { path: "src:2-3" },
	toolCallId: "call-read-2",
	toolName: "read",
});
await settle(3);
console.log(JSON.stringify(outputs.at(-1), null, 2));

section("3. grep content search unchanged");
run({
	input: { path: "src", pattern: "needle" },
	toolCallId: "call-grep-1",
	toolName: "grep",
});
await settle(4);
console.log(JSON.stringify(outputs.at(-1), null, 2));

section(
	"4. stale list call fails closed at the Tool Gate (no alias, no execution)"
);
const stale = await gate.gate({
	family: "coding",
	toolCall: {
		input: {},
		toolCallId: "call-list-stale",
		toolName: "list",
	} as never,
});
console.log(JSON.stringify(stale, null, 2));

rmSync(workspace, { force: true, recursive: true });
