# Deepening Opportunities

This review covers the current AI consolidation changes around `@wincode/ai`, server chat routes, CLI chat screens, and removed tool Modules.

No `CONTEXT.md`, `LANGUAGE.md`, or ADR files exist in this repository yet, so this document uses the architecture vocabulary from the review request.

## 1. Tool-Call Execution Module

**Files**

- `packages/ai/src/client.ts`
- `packages/ai/src/tools/*/runner.ts`

**Problem**

`client.ts` keeps the type-safe literal `switch`, but repeats the same output/error Implementation in every tool branch. The Module is still somewhat **Shallow**: callers get one Interface, but maintainers must scan every branch to understand shared error behavior and output ordering.

The deletion test says the Module is useful because deleting it would push client-side tool-call handling back into CLI screens. The friction is inside the Implementation, where common behavior lacks **Locality**.

**Solution**

Deepen the tool-call execution Module behind one local execution helper while preserving literal tool-name narrowing. Do not use erased registry maps, `any`, `Object.entries`, `Object.fromEntries`, or casts that sever the link between tool name, input, runner output, and `addToolOutput`.

**Benefits**

Callers keep the same small Interface: `handleCodingAgentToolCall(addToolOutput)`. Maintainers get better **Locality** for output/error behavior. Tests can target tool-call execution through the Interface instead of relying on full chat hook setup.

## 2. Workspace Sandbox Module

**Files**

- `packages/ai/src/workspace.ts`
- `packages/ai/src/tools/*/runner.ts`

**Problem**

`WORKSPACE = process.cwd()` is hidden global state. `resolveWithinWorkspace()` checks a resolved path string, but it does not verify the final realpath for each file operation. A symlink inside the workspace can point outside the workspace, so the Interface promises containment that the Implementation does not fully enforce.

The Module is **Shallow** because callers must still trust unstated invariants: process cwd timing, symlink behavior, and which operations follow paths after validation.

**Solution**

Deepen workspace handling into a runtime workspace Module. The Module should own path resolution, symlink policy, and error modes. Tool runners should depend on that Interface rather than directly depending on `process.cwd()` and raw path checks.

**Benefits**

Sandbox correctness gains **Locality**. Every file tool gets more **Leverage** from one containment Interface. Tests improve because the workspace Interface becomes the test surface for path escape, symlink escape, and valid workspace paths.

## 3. Grep/List Traversal Module

**Files**

- `packages/ai/src/tools/grep/runner.ts`
- `packages/ai/src/tools/list/runner.ts`

**Problem**

Recursive traversal is embedded separately in tool runners. `grep` with default path `"."` can traverse `.git`, `node_modules`, build output, binary files, or very large trees. The traversal Interface does not document limits, ignore rules, binary handling, or error modes.

The deletion test shows traversal deserves its own Module: deleting shared traversal would recreate the same policy questions in every filesystem tool.

**Solution**

Deepen traversal behind one file discovery Module. It should define deterministic ordering, ignored directories, file-size limits, binary skip behavior, and match/file caps. `grep` and `list` become Adapters over that traversal Interface.

**Benefits**

Traversal policy gets **Locality**. Filesystem tools get **Leverage** from one tested discovery Interface. Tests can cover traversal once, then test `grep` and `list` for their specific behavior.

## 4. Tool Registry Module

**Status:** Implemented.

**Files**

- `packages/ai/src/tools/schemas.ts`
- `packages/ai/src/tools/runners.ts`
- `packages/ai/src/server/tools.ts`
- `packages/ai/src/client.ts`

**Result**

Central `codingToolDefinitions` registry drives compile-time mirrors: `codingToolRunners` (client), `codingServerTools` (server). Explicit `satisfies` maps ensure incomplete additions fail type-check. Server and CLI app files stay unchanged when adding a tool.

## 5. Agent Configuration Module

**Status:** Partially implemented.

**Files**

- `packages/ai/src/server/index.ts`
- `packages/ai/src/server/agent.ts`
- `packages/ai/src/server/model.ts`
- `packages/ai/src/server/stream.ts`
- `packages/ai/src/server/tools.ts`
- `packages/ai/src/instructions.ts`

**Problem**

`server.ts` (now `server/index.ts`) previously mixed model selection, provider options, devtools middleware, tool definitions, stream response creation, and message type export. Several change reasons concentrated in one file.

**Solution applied**

- Internal implementation split into focused files:
  - `agent.ts`: `ToolLoopAgent` assembly
  - `model.ts`: model + provider options + devtools gate (local-dev only)
  - `stream.ts`: `createCodingAgentStreamResponse` factory
  - `tools.ts`: server-side `codingServerTools` mirror
- Public facade (`server/index.ts`) exports minimal Interface:
  - `codingAgent` (lower-level, for type inference/tests)
  - `CodingAgentUIMessage`
  - `createCodingAgentStreamResponse`
- `codingServerTools` is no longer public; tested via internal import.
- Instructions updated to remove “Run relevant checks after changes” since `bash` tool was removed.

**Benefits**

Server routes get high **Leverage** from a small Interface. Model/provider/tool setup gains **Locality** inside the AI package.

## 6. CodingAgentUIMessage Seam

**Status:** Implemented.

**Files**

- `packages/ai/src/message.ts`
- `packages/ai/src/shared.ts`
- `packages/ai/src/server/index.ts`
- `packages/ai/src/client.ts`
- `apps/cli/src/**/*.tsx`

**Problem addressed**

CLI UI Modules import `CodingAgentUIMessage` from `@wincode/ai/server`. This is type-only, but the Seam reads wrong: UI code appears to depend on the server entry. That hurts AI-navigability and makes the package Interface harder to understand.

**Solution applied**

Moved the message Interface to the root shared entry. `packages/ai/src/message.ts` defines `CodingAgentTools` and `CodingAgentUIMessage` from the shared tool registry, so it does not import server model/provider setup. CLI UI Modules now import `CodingAgentUIMessage` from `@wincode/ai`. Server Implementation, model setup, stream response creation, and public `codingAgent` remain behind `@wincode/ai/server`.

**Benefits**

CLI Modules get a clearer Interface. Server Implementation keeps **Locality**. The Seam becomes easier to navigate: shared message shape in shared entry, server stream behavior in server entry, client tool-call handling in client entry.

## Correctness Risks Found During Review

1. `packages/ai/src/workspace.ts`: symlink escape can violate the workspace containment Interface.
2. `packages/ai/src/tools/grep/runner.ts`: unbounded recursive reads from `"."` can traverse huge, generated, hidden, or binary paths.
