# MCP Lifecycle and Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenCode-v2-compatible local and remote MCP tool support while keeping all MCP connection, authorization, and execution inside Wincode CLI.

**Architecture:** CLI owns config, MCP SDK clients, immutable catalog snapshots, policy, approval, and calls. `packages/ai` owns bounded wire schemas and creates model-visible dynamic tools with no `execute` callback; hosted server validates and forwards those schemas only. Both hosted and direct-model transports attach a Build-mode snapshot, while Plan mode always sends an empty manifest.

**Tech Stack:** Bun, TypeScript, React 19, OpenTUI React, AI SDK 6, Zod 4, MCP TypeScript SDK v2, JSONC Parser, Hono.

---

## File Map

### Shared AI contracts and hosted model

- Create `packages/ai/src/mcp-tools.ts`: bounded JSON-safe manifest schemas, constants, and types.
- Create `packages/ai/src/mcp-tools.test.ts`: manifest count, names, descriptions, schema bytes, and total bytes.
- Create `packages/ai/src/server/mcp-tools.ts`: convert manifest entries to client-executed dynamic AI SDK tools with no `execute` function.
- Create `packages/ai/src/server/mcp-tools.test.ts`: dynamic marker, JSON Schema, and no hosted execution callback.
- Modify `packages/ai/src/shared.ts`: export MCP wire contracts.
- Modify `packages/ai/src/server/index.ts`: export server conversion helper.
- Modify `packages/ai/src/modes.ts`: add bounded `mcpTools` to agent call options.
- Modify `packages/ai/src/server/agent.ts`: merge dynamic tools per call and activate them only in Build mode.
- Modify `packages/ai/src/server/stream.ts`: accept and forward request manifest.
- Modify `packages/ai/src/ai-package.test.ts`: cover dynamic tool activation and Plan omission.

### Hosted route

- Modify `apps/server/src/routes/sessions.ts`: validate `mcpTools`, include serialized bytes in funded context, validate UI messages with request tools, and forward manifest.
- Modify `apps/server/src/routes/sessions.integration.test.ts`: valid manifest, Plan rejection/omission, limits, billing overhead, and stream forwarding.

### CLI MCP module

- Create `apps/cli/src/modules/mcp/config.ts`: discover, parse, merge, validate, and interpolate OpenCode v2 config.
- Create `apps/cli/src/modules/mcp/config.test.ts`: JSONC, source precedence, duplicate file warning, invalid server isolation, and secret-safe missing-env behavior.
- Create `apps/cli/src/modules/mcp/policy.ts`: parse `.wincode/mcp.json` and resolve `allow | ask | deny`.
- Create `apps/cli/src/modules/mcp/policy.test.ts`: defaults and unknown-server warnings.
- Create `apps/cli/src/modules/mcp/tool-identity.ts`: stable qualified name generation.
- Create `apps/cli/src/modules/mcp/tool-identity.test.ts`: sanitization, 64-character cap, and collision resistance.
- Create `apps/cli/src/modules/mcp/result.ts`: normalize and bound MCP output.
- Create `apps/cli/src/modules/mcp/result.test.ts`: text, structured content, binary metadata, errors, and truncation.
- Create `apps/cli/src/modules/mcp/client.ts`: narrow MCP client interface and SDK v2 implementation for stdio/Streamable HTTP.
- Create `apps/cli/src/modules/mcp/client.test.ts`: transport construction and secret-safe errors with injected SDK factories.
- Create `apps/cli/src/modules/mcp/registry.ts`: lazy connection lifecycle, immutable snapshots, policy, execution, refresh, status, reconnect, and shutdown.
- Create `apps/cli/src/modules/mcp/registry.test.ts`: fake-client lifecycle and execution matrix.
- Create `apps/cli/src/modules/mcp/context/mcp-provider.tsx`: React context, registry subscription, approval bridge, and summary toast.
- Create `apps/cli/src/modules/mcp/context/mcp-provider.test.ts`: approval resolution and dynamic output behavior.
- Create `apps/cli/src/modules/mcp/ui/mcp-approval-dialog.tsx`: allow-once/deny interaction.
- Create `apps/cli/src/modules/mcp/ui/mcp-status-dialog.tsx`: server status and reconnect UI.
- Create `apps/cli/src/modules/mcp/index.ts`: focused public API.
- Create `apps/cli/src/modules/mcp/README.md`: ownership, config, public API, dependencies, and deferred capabilities.

### CLI integration

- Modify `apps/cli/package.json` and `bun.lock`: direct MCP client, test server, and JSONC dependencies.
- Modify `apps/cli/src/app/layouts/root-layout.tsx`: process-lifetime MCP registry/provider composition.
- Modify `apps/cli/src/modules/conversations/api/chat-request.ts`: attach hosted manifest.
- Modify `apps/cli/src/modules/conversations/api/chat-request.test.ts`: Build inclusion and Plan omission.
- Modify `apps/cli/src/modules/conversations/hooks/routing-chat-transport.ts`: create one immutable snapshot per request.
- Modify `apps/cli/src/modules/conversations/hooks/local-chat-transport.ts`: expose same snapshot to direct models.
- Modify `apps/cli/src/modules/conversations/hooks/use-chat.ts`: execute dynamic calls against active snapshot without deadlocking AI SDK.
- Modify `apps/cli/src/modules/conversations/hooks/use-chat.test.ts`: dynamic dispatch and stale snapshot behavior.
- Modify `apps/cli/src/modules/commands/commands.ts`: register `/mcp` dialog command.
- Modify `apps/cli/src/modules/commands/commands.test.ts`: update count and MCP command assertion.
- Modify `apps/cli/src/modules/commands/adapters/dialog-adapter.ts`: add MCP title.
- Modify `apps/cli/src/app/commands/use-app-command-executor.tsx`: open MCP status and close registry before renderer destruction.

### Integration fixtures

- Create `apps/cli/src/modules/mcp/fixtures/stdio-server.ts`: real MCP v2 echo tool over stdio.
- Create `apps/cli/src/modules/mcp/mcp.integration.test.ts`: stdio and Streamable HTTP discovery/call/cleanup.

## Task 1: Add Bounded MCP Wire Contracts

**Files:**
- Create: `packages/ai/src/mcp-tools.ts`
- Create: `packages/ai/src/mcp-tools.test.ts`
- Modify: `packages/ai/src/shared.ts`

- [ ] **Step 1: Write failing manifest-schema tests**

```ts
import { describe, expect, test } from "bun:test";
import {
	MAX_MCP_MANIFEST_BYTES,
	MAX_MCP_TOOL_COUNT,
	mcpToolManifestSchema,
} from "./mcp-tools";

const tool = {
	description: "Read an issue",
	inputSchema: { type: "object", properties: { id: { type: "string" } } },
	name: "mcp_github_read_issue_a1b2c3d4",
};

describe("mcpToolManifestSchema", () => {
	test("accepts bounded JSON Schema tool definitions", () => {
		expect(mcpToolManifestSchema.parse([tool])).toEqual([tool]);
	});

	test("rejects too many tools", () => {
		expect(() =>
			mcpToolManifestSchema.parse(Array.from({ length: MAX_MCP_TOOL_COUNT + 1 }, () => tool))
		).toThrow();
	});

	test("rejects oversized complete manifests", () => {
		const tools = Array.from({ length: 40 }, (_, index) => ({
			...tool,
			description: "x".repeat(7000),
			name: `mcp_demo_tool_${index}`,
		}));
		expect(() => mcpToolManifestSchema.parse(tools)).toThrow("MCP tool manifest is too large");
	});

	test("rejects duplicate model-visible names", () => {
		expect(() => mcpToolManifestSchema.parse([tool, tool])).toThrow("Duplicate MCP tool name");
	});
});
```

- [ ] **Step 2: Run test and verify red**

Run: `bun test packages/ai/src/mcp-tools.test.ts`

Expected: FAIL with `Cannot find module './mcp-tools'`.

- [ ] **Step 3: Implement constants, recursive JSON values, and bounded schema**

```ts
import { z } from "zod";

export const MAX_MCP_TOOL_COUNT = 128;
export const MAX_MCP_TOOL_NAME_LENGTH = 64;
export const MAX_MCP_TOOL_DESCRIPTION_BYTES = 8 * 1024;
export const MAX_MCP_TOOL_SCHEMA_BYTES = 64 * 1024;
export const MAX_MCP_MANIFEST_BYTES = 256 * 1024;
export const MAX_MCP_RESULT_BYTES = 256 * 1024;
export const MCP_TOOL_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

export type JsonValue =
	| boolean
	| null
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.boolean(),
		z.null(),
		z.number(),
		z.string(),
		z.array(jsonValueSchema),
		z.record(z.string(), jsonValueSchema),
	])
);

const utf8Bytes = (value: unknown): number =>
	new TextEncoder().encode(JSON.stringify(value)).byteLength;

export const mcpToolManifestEntrySchema = z
	.object({
		description: z.string().refine(
			(value) => new TextEncoder().encode(value).byteLength <= MAX_MCP_TOOL_DESCRIPTION_BYTES,
			"MCP tool description is too large"
		),
		inputSchema: z
			.record(z.string(), jsonValueSchema)
			.refine((value) => utf8Bytes(value) <= MAX_MCP_TOOL_SCHEMA_BYTES, "MCP tool schema is too large"),
		name: z.string().min(1).max(MAX_MCP_TOOL_NAME_LENGTH).regex(MCP_TOOL_NAME_REGEX),
	})
	.strict();

export const mcpToolManifestSchema = z
	.array(mcpToolManifestEntrySchema)
	.max(MAX_MCP_TOOL_COUNT)
	.superRefine((value, context) => {
		const names = new Set<string>();
		for (const entry of value) {
			if (names.has(entry.name)) {
				context.addIssue({ code: "custom", message: "Duplicate MCP tool name" });
			}
			names.add(entry.name);
		}
		if (utf8Bytes(value) > MAX_MCP_MANIFEST_BYTES) {
			context.addIssue({ code: "custom", message: "MCP tool manifest is too large" });
		}
	});

export type McpToolManifestEntry = z.infer<typeof mcpToolManifestEntrySchema>;
export type McpToolManifest = z.infer<typeof mcpToolManifestSchema>;
```

Export types, constants, and schemas from `packages/ai/src/shared.ts` with explicit named exports.

- [ ] **Step 4: Run focused tests**

Run: `bun test packages/ai/src/mcp-tools.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/mcp-tools.ts packages/ai/src/mcp-tools.test.ts packages/ai/src/shared.ts
git commit -m "feat(ai): add MCP manifest contracts"
```

## Task 2: Create Schema-Only Dynamic Agent Tools

**Files:**
- Create: `packages/ai/src/server/mcp-tools.ts`
- Create: `packages/ai/src/server/mcp-tools.test.ts`
- Modify: `packages/ai/src/server/index.ts`
- Modify: `packages/ai/src/modes.ts`
- Modify: `packages/ai/src/server/agent.ts`
- Modify: `packages/ai/src/server/stream.ts`
- Modify: `packages/ai/src/ai-package.test.ts`

- [ ] **Step 1: Write failing conversion test**

```ts
import { expect, test } from "bun:test";
import { createMcpServerTools } from "./mcp-tools";

test("creates client-executed dynamic tools without execute callbacks", () => {
	const tools = createMcpServerTools([
		{ description: "Echo", inputSchema: { type: "object" }, name: "mcp_demo_echo_12345678" },
	]);
	const tool = tools.mcp_demo_echo_12345678;
	expect(tool?.type).toBe("dynamic");
	expect(tool?.execute).toBeUndefined();
});
```

- [ ] **Step 2: Run test and verify red**

Run: `bun test packages/ai/src/server/mcp-tools.test.ts`

Expected: FAIL with missing module/export.

- [ ] **Step 3: Implement client-executed dynamic definitions**

Do not use `dynamicTool()`: AI SDK 6 requires its `execute` callback. Build the valid `Tool<unknown, never>` shape directly so the dynamic marker reaches UI streams but hosted execution remains impossible.

```ts
import type { Tool, ToolSet } from "ai";
import { jsonSchema } from "ai";
import type { McpToolManifest } from "../mcp-tools";

type ClientExecutedDynamicTool = Tool<unknown, never> & { type: "dynamic" };

export const createMcpServerTools = (manifest: McpToolManifest): ToolSet => {
	const tools: Record<string, ClientExecutedDynamicTool> = {};
	for (const entry of manifest) {
		tools[entry.name] = {
			description: entry.description,
			inputSchema: jsonSchema(entry.inputSchema),
			type: "dynamic",
		};
	}
	return tools;
};
```

Add `mcpTools: mcpToolManifestSchema.optional()` to `codingAgentCallOptionsSchema`. In `createCodingAgent`, type tools as `ToolSet`, create request tools in `prepareCall`, return merged `tools`, and set `activeTools` to built-ins plus manifest names only when mode is `build`. In `createCodingAgentStreamResponse`, accept `mcpTools = []` and pass it in agent `options`.

- [ ] **Step 4: Add agent behavior tests**

Extend `packages/ai/src/ai-package.test.ts` to assert:

```ts
expect(buildPrepared.tools?.mcp_demo_echo_12345678).toBeDefined();
expect(buildPrepared.activeTools).toContain("mcp_demo_echo_12345678");
expect(planPrepared.activeTools).not.toContain("mcp_demo_echo_12345678");
```

Also assert every generated MCP tool has no `execute` property.

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test packages/ai/src/server/mcp-tools.test.ts packages/ai/src/ai-package.test.ts`

Expected: PASS.

Run: `bun run --filter @wincode/ai check-types`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/ai/src/server/mcp-tools.ts packages/ai/src/server/mcp-tools.test.ts packages/ai/src/server/index.ts packages/ai/src/modes.ts packages/ai/src/server/agent.ts packages/ai/src/server/stream.ts packages/ai/src/ai-package.test.ts
git commit -m "feat(ai): expose client-executed MCP tools"
```

## Task 3: Validate MCP Manifests on Hosted Chat

**Files:**
- Modify: `apps/server/src/routes/sessions.ts`
- Modify: `apps/server/src/routes/sessions.integration.test.ts`

- [ ] **Step 1: Add failing route tests**

Update the test module's mocked `codingModeNameSchema` from `z.enum(["plan"])` to `z.enum(["build", "plan"])`. Add tests that POST one valid Build manifest, an oversized description, a Plan request containing MCP tools, and historical `dynamic-tool` parts whose tool is absent from the current manifest. Capture the stream dependency input. Historical parts must validate structurally but never become active tools.

```ts
test("forwards bounded Build MCP tools to the agent", async () => {
	const response = await sessionsRoutes.request("/session-mcp/chat", {
		body: JSON.stringify({
			messages: [{ id: "u1", parts: [{ text: "echo", type: "text" }], role: "user" }],
			mode: "build",
			model: "gpt-5.4-mini",
			mcpTools: [{ description: "Echo", inputSchema: { type: "object" }, name: "mcp_demo_echo_12345678" }],
		}),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
	expect(response.status).toBe(200);
	expect(createCodingAgentStreamResponse).toHaveBeenLastCalledWith(
		expect.objectContaining({ mcpTools: [expect.objectContaining({ name: "mcp_demo_echo_12345678" })] })
	);
});
```

- [ ] **Step 2: Run test and verify red**

Run: `bun test apps/server/src/routes/sessions.integration.test.ts`

Expected: FAIL because `mcpTools` is stripped/not forwarded.

- [ ] **Step 3: Extend request validation and accounting**

Import `mcpToolManifestSchema` and `createMcpServerTools`. Add:

```ts
const chatRequestSchema = z.object({
	// existing fields stay unchanged
	mcpTools: mcpToolManifestSchema.optional(),
});
```

After parsing, reject a non-empty Plan manifest rather than silently accepting client policy failure:

```ts
const mcpTools = parsed.data.mcpTools ?? [];
if (mode === "plan" && mcpTools.length > 0) {
	return badRequest();
}
const requestTools = { ...deps.codingServerTools, ...createMcpServerTools(mcpTools) };
```

Use `requestTools` in `safeValidateUIMessages`, subtract `getStringTokenEstimate(JSON.stringify(mcpTools))` from `fundedInputTokenBudget`, and forward `mcpTools` to `createCodingAgentStreamResponse`.

- [ ] **Step 4: Run route tests**

Run: `bun test apps/server/src/routes/sessions.integration.test.ts`

Expected: PASS, including malformed/oversized and funded-input tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/sessions.ts apps/server/src/routes/sessions.integration.test.ts
git commit -m "feat(server): validate MCP tool manifests"
```

## Task 4: Load OpenCode v2 Config Safely

**Files:**
- Modify: `apps/cli/package.json`
- Modify: `bun.lock`
- Create: `apps/cli/src/modules/mcp/config.ts`
- Create: `apps/cli/src/modules/mcp/config.test.ts`

- [ ] **Step 1: Add direct dependencies**

Run:

```bash
bun add --cwd apps/cli @modelcontextprotocol/client jsonc-parser
bun add --cwd apps/cli --dev @modelcontextprotocol/server @modelcontextprotocol/hono
```

Expected: `apps/cli/package.json` and `bun.lock` updated; no install errors.

- [ ] **Step 2: Write failing config tests with temporary global/workspace roots**

Cover `.jsonc` preference, global/project merge, local/remote discriminants, timeout defaults, missing env, OAuth object, invalid server isolation, and secret-safe diagnostics. Define test helpers in the same file:

```ts
const writeConfig = async (
	root: string,
	name: "opencode.json" | "opencode.jsonc",
	value: object | string
): Promise<void> => {
	await Bun.write(join(root, name), typeof value === "string" ? value : JSON.stringify(value));
};
```

```ts
test("merges project server fields over global config", async () => {
	await writeConfig(globalRoot, "opencode.json", {
		mcp: { servers: { demo: { type: "remote", url: "https://global.test/mcp", headers: { A: "1" } } } },
	});
	await writeConfig(workspace, "opencode.jsonc", `{
		"mcp": { "servers": { "demo": { "headers": { "B": "{env:TOKEN}" } } } }
	}`);
	const loaded = await loadMcpConfig({ env: { TOKEN: "secret" }, globalRoot, workspace });
	expect(loaded.servers.demo).toMatchObject({
		type: "remote",
		url: "https://global.test/mcp",
		headers: { A: "1", B: "secret" },
	});
	expect(JSON.stringify(loaded.diagnostics)).not.toContain("secret");
});
```

- [ ] **Step 3: Run test and verify red**

Run: `bun test apps/cli/src/modules/mcp/config.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 4: Implement config loader**

Define discriminated `LocalMcpServerConfig`, `RemoteMcpServerConfig`, phase timeouts, and `McpConfigDiagnostic`. Use `jsonc-parser`'s `parse`, choose `.jsonc` when both files exist, and report duplicate choice. Parse top-level files independently, merge raw timeout fields and each raw server by name, then validate each merged server independently so one bad server cannot erase others.

Use these defaults:

```ts
export const DEFAULT_MCP_TIMEOUTS = {
	catalog: 30_000,
	execution: 12 * 60 * 60 * 1000,
	startup: 30_000,
} as const;
```

Resolve only full `{env:NAME}` tokens in local `environment` and remote `headers`. Missing variables produce a diagnostic containing server and variable names, mark that server unavailable, and never include any resolved value. Treat remote OAuth objects as unsupported; `oauth: false` and omitted OAuth connect without OAuth. Accept and discard `codemode`.

- [ ] **Step 5: Run config tests**

Run: `bun test apps/cli/src/modules/mcp/config.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/package.json bun.lock apps/cli/src/modules/mcp/config.ts apps/cli/src/modules/mcp/config.test.ts
git commit -m "feat(cli): load OpenCode MCP config"
```

## Task 5: Add Policy, Tool Identity, and Result Bounds

**Files:**
- Create: `apps/cli/src/modules/mcp/policy.ts`
- Create: `apps/cli/src/modules/mcp/policy.test.ts`
- Create: `apps/cli/src/modules/mcp/tool-identity.ts`
- Create: `apps/cli/src/modules/mcp/tool-identity.test.ts`
- Create: `apps/cli/src/modules/mcp/result.ts`
- Create: `apps/cli/src/modules/mcp/result.test.ts`

- [ ] **Step 1: Write failing pure-function tests**

```ts
test("defaults unknown configured servers to ask", () => {
	expect(resolveMcpPolicy({}, "github")).toBe("ask");
});

test("creates stable bounded qualified names", async () => {
	const name = await qualifyMcpToolName("server with spaces", "tool/with/punctuation");
	expect(name).toMatch(/^mcp_[A-Za-z0-9_-]+_[a-f0-9]{8}$/);
	expect(name.length).toBeLessThanOrEqual(64);
	expect(await qualifyMcpToolName("server with spaces", "tool/with/punctuation")).toBe(name);
});

test("replaces binary content with metadata", () => {
	expect(normalizeMcpResult({ content: [{ type: "image", data: "base64", mimeType: "image/png" }] })).toEqual({
		content: [{ type: "binary-metadata", mediaType: "image/png", originalType: "image" }],
		isError: false,
		truncated: false,
	});
});
```

- [ ] **Step 2: Run tests and verify red**

Run: `bun test apps/cli/src/modules/mcp/policy.test.ts apps/cli/src/modules/mcp/tool-identity.test.ts apps/cli/src/modules/mcp/result.test.ts`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement policy parsing**

Parse `.wincode/mcp.json` with Zod:

```ts
export const mcpExecutionPolicySchema = z.enum(["allow", "ask", "deny"]);
const mcpPolicyFileSchema = z.object({
	servers: z.record(z.string(), mcpExecutionPolicySchema).default({}),
});
export type McpExecutionPolicy = z.infer<typeof mcpExecutionPolicySchema>;
export const resolveMcpPolicy = (
	policies: Readonly<Record<string, McpExecutionPolicy>>,
	serverName: string
): McpExecutionPolicy => policies[serverName] ?? "ask";
```

Return diagnostics for malformed files and policy keys absent from configured servers.

- [ ] **Step 4: Implement identity and normalization**

Use `crypto.subtle.digest("SHA-256", ...)`, first eight lowercase hex characters, ASCII sanitization, and deterministic truncation before suffix assembly. Preserve MCP text and `structuredContent`; convert image/audio/resource links to metadata; stringify only JSON-safe values. If encoded output exceeds `MAX_MCP_RESULT_BYTES`, truncate text at a UTF-8 boundary and set `truncated: true`.

Export this stable normalized shape from `result.ts`:

```ts
export type McpNormalizedResult = {
	content: JsonValue[];
	isError: boolean;
	structuredContent?: JsonValue;
	truncated: boolean;
};
```

- [ ] **Step 5: Run tests**

Run: `bun test apps/cli/src/modules/mcp/policy.test.ts apps/cli/src/modules/mcp/tool-identity.test.ts apps/cli/src/modules/mcp/result.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/modules/mcp/policy.ts apps/cli/src/modules/mcp/policy.test.ts apps/cli/src/modules/mcp/tool-identity.ts apps/cli/src/modules/mcp/tool-identity.test.ts apps/cli/src/modules/mcp/result.ts apps/cli/src/modules/mcp/result.test.ts
git commit -m "feat(cli): add MCP policy and normalization"
```

## Task 6: Wrap MCP SDK v2 Behind a Narrow Client

**Files:**
- Create: `apps/cli/src/modules/mcp/client.ts`
- Create: `apps/cli/src/modules/mcp/client.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Inject factories rather than mocking package modules. Assert local command splits executable/args without shell, local cwd/env reach stdio options, remote URL/headers reach `requestInit`, `listTools` and `callTool` delegate, and errors are sanitized.

```ts
test("constructs local stdio transport from argv", async () => {
	const transports: unknown[] = [];
	const workspace = "/workspace";
	const inheritedEnvironment = { PATH: "/bin" };
	const localConfig = {
		command: ["bun", "x", "demo"] as [string, ...string[]],
		cwd: workspace,
		disabled: false,
		environment: { LOG_LEVEL: "info" },
		name: "demo",
		timeout: { catalog: 30_000, execution: 43_200_000, startup: 30_000 },
		type: "local" as const,
	};
	const adapter = createSdkMcpClient(localConfig, {
		environment: inheritedEnvironment,
		createClient: fakeClientFactory,
		createStdioTransport: (options) => {
			transports.push(options);
			return fakeTransport;
		},
		createHttpTransport: failFactory,
	});
	await adapter.connect();
	expect(transports).toEqual([
		{
			args: ["x", "demo"],
			command: "bun",
			cwd: workspace,
			env: { LOG_LEVEL: "info", PATH: "/bin" },
		},
	]);
});
```

- [ ] **Step 2: Run test and verify red**

Run: `bun test apps/cli/src/modules/mcp/client.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Define adapter contract and SDK implementation**

```ts
export type McpClientTool = {
	description?: string;
	inputSchema: Record<string, JsonValue>;
	name: string;
};

export type McpClient = {
	callTool(name: string, input: unknown, signal?: AbortSignal): Promise<unknown>;
	close(): Promise<void>;
	connect(signal?: AbortSignal): Promise<void>;
	listTools(signal?: AbortSignal): Promise<readonly McpClientTool[]>;
};
```

Use:

```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
```

Construct `Client` with `listChanged.tools.onChanged`, forwarding refreshed tool arrays to an injected callback. Local transport receives `{ command, args, cwd, env }`. Remote transport receives `new URL(config.url)` and `{ requestInit: { headers: config.headers } }`. Delegate `client.callTool({ name, arguments: input })`; do not add SSE fallback or OAuth.

- [ ] **Step 4: Run adapter tests**

Run: `bun test apps/cli/src/modules/mcp/client.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/modules/mcp/client.ts apps/cli/src/modules/mcp/client.test.ts
git commit -m "feat(cli): add MCP client transports"
```

## Task 7: Build Lazy Registry and Immutable Snapshots

**Files:**
- Create: `apps/cli/src/modules/mcp/registry.ts`
- Create: `apps/cli/src/modules/mcp/registry.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Use fake clients keyed by server. Cover:

```ts
test("connects enabled servers concurrently and isolates failures", async () => {
	const registry = createMcpRegistry(testDependencies);
	const snapshot = await registry.createSnapshot("build");
	expect(snapshot.manifest.map(({ name }) => name)).toHaveLength(1);
	expect(registry.getStatuses()).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ name: "healthy", state: "connected" }),
			expect.objectContaining({ name: "broken", state: "failed" }),
		])
	);
});

test("returns an empty Plan snapshot without connecting", async () => {
	const snapshot = await registry.createSnapshot("plan");
	expect(snapshot.manifest).toEqual([]);
	expect(createClient).not.toHaveBeenCalled();
});

test("executes against the request snapshot after catalog refresh", async () => {
	const snapshot = await registry.createSnapshot("build");
	fakeClient.publishTools([]);
	await expect(registry.execute(snapshot, snapshot.manifest[0]?.name ?? "", {}, approve)).resolves.toMatchObject({ isError: false });
});
```

Also cover deny omission, ask approval, allow bypass, timeout close/degraded state, unknown tool rejection, reconnect, list-change next-snapshot behavior, manifest deterministic limit, subscriptions, and `close()`.

- [ ] **Step 2: Run test and verify red**

Run: `bun test apps/cli/src/modules/mcp/registry.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Define registry public types**

```ts
export type McpCatalogSnapshot = {
	id: string;
	manifest: McpToolManifest;
	mode: ModeType;
	tools: ReadonlyMap<string, McpSnapshotTool>;
};

export type McpSnapshotTool = {
	client: McpClient;
	description: string;
	originalToolName: string;
	policy: McpExecutionPolicy;
	serverName: string;
};

export type McpApprovalRequest = {
	description: string;
	input: unknown;
	originalToolName: string;
	serverName: string;
};

export type McpServerStatus = {
	error?: string;
	name: string;
	state: "idle" | "connecting" | "connected" | "degraded" | "disabled" | "failed";
	toolCount: number;
	transport: "local" | "remote";
};

export type McpRegistry = {
	close(): Promise<void>;
	createSnapshot(mode: ModeType): Promise<McpCatalogSnapshot>;
	execute(
		snapshot: McpCatalogSnapshot,
		toolName: string,
		input: unknown,
		approve: (request: McpApprovalRequest) => Promise<boolean>,
		signal?: AbortSignal
	): Promise<McpNormalizedResult>;
	getStatuses(): readonly McpServerStatus[];
	reconnect(serverName: string): Promise<void>;
	subscribe(listener: () => void): () => void;
};
```

Keep `McpSnapshotTool` module-internal in `index.ts`. Consumers may read snapshot `id`, `mode`, and `manifest`, but only registry/provider code may inspect dispatch entries or call their clients.

- [ ] **Step 4: Implement registry state machine**

Load config/policy once on first Build snapshot. Use one cached initialization promise to prevent duplicate connections. Wrap startup, catalog, and execution with `AbortSignal.timeout()` plus any caller signal. Keep each snapshot's dispatch map immutable. Recheck snapshot mode/policy immediately before call. Close and mark degraded after disconnect or timeout. Sort server names and original tool names before applying manifest limits. Emit one subscription update per state transition batch.

- [ ] **Step 5: Run registry tests**

Run: `bun test apps/cli/src/modules/mcp/registry.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/modules/mcp/registry.ts apps/cli/src/modules/mcp/registry.test.ts
git commit -m "feat(cli): add MCP lifecycle registry"
```

## Task 8: Add React Provider and Approval Flow

**Files:**
- Create: `apps/cli/src/modules/mcp/context/mcp-provider.tsx`
- Create: `apps/cli/src/modules/mcp/context/mcp-provider.test.ts`
- Create: `apps/cli/src/modules/mcp/ui/mcp-approval-dialog.tsx`
- Create: `apps/cli/src/modules/mcp/index.ts`
- Create: `apps/cli/src/modules/mcp/README.md`

- [ ] **Step 1: Write failing approval-controller tests**

Extract `createMcpApprovalController()` so promise behavior is testable without renderer setup.

```ts
test("denies once when approval UI unmounts", async () => {
	const controller = createMcpApprovalController();
	const decision = controller.request(approvalRequest);
	controller.cancel();
	expect(await decision).toBe(false);
	controller.allow();
	expect(await decision).toBe(false);
});
```

- [ ] **Step 2: Run test and verify red**

Run: `bun test apps/cli/src/modules/mcp/context/mcp-provider.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement provider contract**

Expose:

```ts
export type McpContextValue = {
	close(): Promise<void>;
	createSnapshot(mode: ModeType): Promise<McpCatalogSnapshot>;
	handleDynamicToolCall(
		snapshot: McpCatalogSnapshot | null,
		toolCall: DynamicToolCall,
		addToolOutput: ChatAddToolOutputFunction<CodingAgentUIMessage>
	): Promise<void>;
	reconnect(serverName: string): Promise<void>;
	statuses: readonly McpServerStatus[];
};
```

Use `useSyncExternalStore(registry.subscribe, registry.getStatuses, registry.getStatuses)`. `handleDynamicToolCall` rejects null/stale snapshots as `output-error`, opens approval only for `ask`, executes through registry, and calls `addToolOutput`. Sanitize all caught errors to a stable message. Provider must not await from AI SDK's `onToolCall`; that rule is enforced in Task 9's caller.

- [ ] **Step 4: Implement approval dialog**

Render server, original tool, description, and formatted bounded input. `Allow once` resolves true; `Deny`, Escape, and unmount resolve false. Use semantic OpenTUI `<button>` elements and top keyboard-layer checks. Never render config, env, headers, or URL.

- [ ] **Step 5: Add public API and README**

`index.ts` exports only `createMcpRegistry`, `McpProvider`, `useMcp`, status/approval types needed by app composition, and `McpStatusDialogContent` after Task 10. README documents module purpose, global/project OpenCode sources, `.wincode/mcp.json`, Build/Plan behavior, trusted-process warning, and deferred surfaces.

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test apps/cli/src/modules/mcp/context/mcp-provider.test.ts`

Expected: PASS.

Run: `bun run --cwd apps/cli check-types`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/modules/mcp/context/mcp-provider.tsx apps/cli/src/modules/mcp/context/mcp-provider.test.ts apps/cli/src/modules/mcp/ui/mcp-approval-dialog.tsx apps/cli/src/modules/mcp/index.ts apps/cli/src/modules/mcp/README.md
git commit -m "feat(cli): add MCP provider and approval"
```

## Task 9: Integrate Snapshots with Hosted and Direct Chat

**Files:**
- Modify: `apps/cli/src/modules/conversations/api/chat-request.ts`
- Modify: `apps/cli/src/modules/conversations/api/chat-request.test.ts`
- Modify: `apps/cli/src/modules/conversations/hooks/routing-chat-transport.ts`
- Modify: `apps/cli/src/modules/conversations/hooks/local-chat-transport.ts`
- Modify: `apps/cli/src/modules/conversations/hooks/use-chat.ts`
- Modify: `apps/cli/src/modules/conversations/hooks/use-chat.test.ts`

- [ ] **Step 1: Write failing request and dynamic-dispatch tests**

```ts
test("includes Build MCP manifest", () => {
	const body = prepareSendChatRequestBody("session-1", messages, fallback, manifest);
	expect(body.mcpTools).toEqual(manifest);
});

test("omits MCP manifest in Plan mode", () => {
	const body = prepareSendChatRequestBody("session-1", planMessages, planFallback, manifest);
	expect(body.mcpTools).toBeUndefined();
});
```

In `use-chat.test.ts`, assert a dynamic tool call reaches MCP handler with the active snapshot while a static `read` call still reaches `handleCodingAgentToolCall`.

- [ ] **Step 2: Run tests and verify red**

Run: `bun test apps/cli/src/modules/conversations/api/chat-request.test.ts apps/cli/src/modules/conversations/hooks/use-chat.test.ts`

Expected: FAIL because no manifest/snapshot path exists.

- [ ] **Step 3: Attach one snapshot per transport request**

Add `mcpTools?: McpToolManifest` to hosted body. Extend `createRoutingChatTransport` with `mcp: McpContextValue` and `snapshotRef`. At the start of every `sendMessages`, call `mcp.createSnapshot(modeRef.current)` and assign the returned immutable snapshot to the ref before selecting hosted/direct route.

For hosted requests, pass `snapshot.manifest` to `prepareSendChatRequestBody`. For direct requests, pass the snapshot to `createLocalChatTransport`; include `mcpTools: snapshot.manifest` in `createAgentUIStream` options. Plan snapshots are already empty and the request builder omits an empty manifest.

- [ ] **Step 4: Dispatch dynamic calls locally without deadlock**

In `useChat`, obtain `mcp = useMcp()` and create `mcpSnapshotRef`. Change `onToolCall`:

```ts
onToolCall: (options) => {
	const addToolOutput = addToolOutputRef.current;
	if (!addToolOutput) {
		return;
	}
	if (options.toolCall.dynamic) {
		Promise.resolve(
			mcp.handleDynamicToolCall(mcpSnapshotRef.current, options.toolCall, addToolOutput)
		).catch(() => undefined);
		return;
	}
	Promise.resolve(handleCodingAgentToolCall(addToolOutput, modeRef.current)(options)).catch(() => undefined);
},
```

Do not return or await either promise from `onToolCall`; AI SDK waits on that callback while `addToolOutput` queues on the same executor.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `bun test apps/cli/src/modules/conversations/api/chat-request.test.ts apps/cli/src/modules/conversations/hooks/use-chat.test.ts`

Expected: PASS.

Run: `bun run --cwd apps/cli check-types`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/modules/conversations/api/chat-request.ts apps/cli/src/modules/conversations/api/chat-request.test.ts apps/cli/src/modules/conversations/hooks/routing-chat-transport.ts apps/cli/src/modules/conversations/hooks/local-chat-transport.ts apps/cli/src/modules/conversations/hooks/use-chat.ts apps/cli/src/modules/conversations/hooks/use-chat.test.ts
git commit -m "feat(cli): route MCP calls through chat"
```

## Task 10: Add MCP Status Command and App Lifecycle

**Files:**
- Create: `apps/cli/src/modules/mcp/ui/mcp-status-dialog.tsx`
- Create: `apps/cli/src/modules/mcp/ui/mcp-status-dialog.test.tsx`
- Modify: `apps/cli/src/modules/mcp/index.ts`
- Modify: `apps/cli/src/app/layouts/root-layout.tsx`
- Modify: `apps/cli/src/modules/commands/commands.ts`
- Modify: `apps/cli/src/modules/commands/commands.test.ts`
- Modify: `apps/cli/src/modules/commands/adapters/dialog-adapter.ts`
- Modify: `apps/cli/src/app/commands/use-app-command-executor.tsx`

- [ ] **Step 1: Write failing command/status tests**

Update command count from 9 to 10 and assert:

```ts
expect(COMMANDS).toContainEqual({
	description: "Inspect MCP servers and reconnect failures",
	dialogKey: "mcp",
	kind: "dialog",
	name: "mcp",
	value: "/mcp",
});
```

Test status-row formatting as a pure export: local rows include the OS-permission warning; errors show sanitized text; reconnect is available only for `degraded` and `failed`.

- [ ] **Step 2: Run tests and verify red**

Run: `bun test apps/cli/src/modules/commands/commands.test.ts apps/cli/src/modules/mcp/ui/mcp-status-dialog.test.tsx`

Expected: FAIL because `/mcp` and status UI do not exist.

- [ ] **Step 3: Implement status dialog and command**

Add `"mcp"` to `dialogKey`, title map, and command registry. Render rows with server, transport, state, tool count, and optional error. Show `Local commands run with your OS permissions and inherited environment.` for local servers. Enter on a failed/degraded row invokes `reconnect(name)` and keeps status visible; Escape closes.

In `use-app-command-executor.tsx`, add the `mcp` dialog switch branch:

```tsx
case "mcp":
	dialog.open({
		children: <McpStatusDialogContent />,
		padding: { bottom: 1, left: 0, right: 0, top: 1 },
		title,
		titleMargin: { left: 4, right: 4 },
		width: CONNECTION_DIALOG_WIDTH,
	});
	break;
```

- [ ] **Step 4: Compose process-lifetime provider and shutdown**

At module scope in `root-layout.tsx`:

```ts
const mcpRegistry = createMcpRegistry({ workspace: process.cwd() });
```

Place `McpProvider` inside both `ToastProvider` and `DialogProvider`, wrapping `Outlet`. In `useCommandExecutor`, call `useMcp()` and change ExitAdapter destruction to:

```ts
destroy: () => {
	void mcp.close().finally(() => renderer.destroy());
},
```

Provider shows one summary toast after first Build catalog initialization: `MCP: X connected, Y failed.` Do not emit one toast per server.

- [ ] **Step 5: Run command/UI tests and typecheck**

Run: `bun test apps/cli/src/modules/commands apps/cli/src/modules/mcp/ui`

Expected: PASS.

Run: `bun run --cwd apps/cli check-types`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/modules/mcp/ui/mcp-status-dialog.tsx apps/cli/src/modules/mcp/ui/mcp-status-dialog.test.tsx apps/cli/src/modules/mcp/index.ts apps/cli/src/app/layouts/root-layout.tsx apps/cli/src/modules/commands/commands.ts apps/cli/src/modules/commands/commands.test.ts apps/cli/src/modules/commands/adapters/dialog-adapter.ts apps/cli/src/app/commands/use-app-command-executor.tsx
git commit -m "feat(cli): add MCP status command"
```

## Task 11: Verify Real stdio and Streamable HTTP Transports

**Files:**
- Create: `apps/cli/src/modules/mcp/fixtures/stdio-server.ts`
- Create: `apps/cli/src/modules/mcp/mcp.integration.test.ts`

- [ ] **Step 1: Create stdio fixture server**

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const createServer = () => {
	const server = new McpServer({ name: "wincode-test", version: "1.0.0" });
	server.registerTool(
		"echo",
		{ description: "Echo text", inputSchema: z.object({ text: z.string() }) },
		async ({ text }) => ({ content: [{ text, type: "text" }] })
	);
	return server;
};

void serveStdio(createServer);
```

- [ ] **Step 2: Write real transport integration tests**

For stdio, configure command `bun <absolute fixture path>`, create snapshot, call echo, assert normalized text, then close and verify process transport closes.

For HTTP, create `McpServer` with the same echo tool, wrap with `createMcpHandler`, start a loopback `Bun.serve({ port: 0, fetch: handler.fetch })`, configure remote URL, discover/call, and stop server in `finally`.

```ts
test("discovers and executes over stdio", async () => {
	const registry = createFixtureRegistry(stdioConfig);
	try {
		const snapshot = await registry.createSnapshot("build");
		const output = await registry.execute(snapshot, snapshot.manifest[0]?.name ?? "", { text: "hello" }, async () => true);
		expect(output).toMatchObject({ content: [{ text: "hello", type: "text" }], isError: false });
	} finally {
		await registry.close();
	}
});
```

- [ ] **Step 3: Run integration tests**

Run: `bun test apps/cli/src/modules/mcp/mcp.integration.test.ts`

Expected: PASS for stdio and Streamable HTTP, with no child process or server left running.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/modules/mcp/fixtures/stdio-server.ts apps/cli/src/modules/mcp/mcp.integration.test.ts
git commit -m "test(cli): cover MCP transports end to end"
```

## Task 12: Security, Architecture, and Full Verification

**Files:**
- Modify: `apps/cli/src/modules/mcp/README.md`
- Modify tests discovered by full verification only when behavior is wrong; do not weaken assertions.

- [ ] **Step 1: Run secret and boundary searches**

Run:

```bash
rg 'headers|environment|url|command' packages/ai/src/mcp-tools.ts packages/ai/src/server/mcp-tools.ts apps/server/src/routes/sessions.ts
```

Expected: no MCP connection config added to shared manifest or hosted agent types. Existing unrelated route/header references are acceptable only outside MCP manifest construction.

Run:

```bash
rg '@modelcontextprotocol/client' packages apps/server
```

Expected: no matches outside `apps/cli`.

- [ ] **Step 2: Run focused MCP suite**

Run:

```bash
bun test packages/ai/src/mcp-tools.test.ts packages/ai/src/server/mcp-tools.test.ts apps/server/src/routes/sessions.integration.test.ts apps/cli/src/modules/mcp apps/cli/src/modules/conversations/api/chat-request.test.ts apps/cli/src/modules/conversations/hooks/use-chat.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run package typechecks**

Run:

```bash
bun run --filter @wincode/ai check-types
bun run --cwd apps/server check-types
bun run --cwd apps/cli check-types
```

Expected: all exit 0.

- [ ] **Step 4: Run complete regression suite**

Run: `bun test apps/cli/src apps/server/src packages/ai/src`

Expected: PASS.

- [ ] **Step 5: Format and lint**

Run: `bun x ultracite fix`

Expected: formatting applied only to intended files.

Run: `bun x ultracite check`

Expected: exit 0.

- [ ] **Step 6: Review final diff against invariants**

Run: `git diff --check && git status --short && git diff --stat`

Confirm:

- MCP SDK imports exist only in CLI.
- Plan mode cannot expose or execute MCP tools.
- Dynamic hosted tools have no `execute` callback.
- No secret values enter manifest, status, toast, errors, or chat.
- Cross-module CLI imports use `@/modules/mcp` public exports.
- MCP module README matches actual config and API.

- [ ] **Step 7: Commit verification fixes**

```bash
git add apps/cli packages/ai apps/server bun.lock
git commit -m "fix(mcp): harden lifecycle boundaries"
```

Skip this commit when verification required no changes.
