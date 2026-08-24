# Tool approval rejection semantics

## Question

When several tool approvals are pending, should rejecting one request reject only that request or interrupt the whole agent turn? The related transport requirement is that rejection must stop an active stream immediately, including while another tool call is still in `input-streaming`.

## OpenCode

OpenCode treats an interactive rejection as a session-level decline, not as an isolated tool result.

- `Permission.ask()` stores each pending permission as a deferred request. A `reject` reply fails the selected deferred and then fails every other pending permission for the same session with `RejectedError`. This makes the queue-wide scope explicit rather than leaving sibling approvals waiting. Source: [`packages/opencode/src/permission/index.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/permission/index.ts).
- The session runner recognizes declined permission errors, clears the outstanding tool fibers, marks unsettled tools as interrupted, and interrupts the effect. The decline therefore terminates the active generation/tool-execution turn instead of waiting for normal tool-input completion. Source: [`packages/core/src/session/runner/llm.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/runner/llm.ts).
- OpenCode distinguishes policy denial from user rejection: a policy `deny` is resolved before creating a pending interactive request, while user rejection follows the deferred rejection and interruption path. Source: [`packages/opencode/src/permission/index.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/permission/index.ts).

## Pi

Pi exposes both semantics and leaves the product decision to the approval extension.

- A `tool_call` extension can reject one tool before execution by returning `{ block: true, reason }`. Pi's first-party permission-gate example uses this mechanism. Source: [`packages/coding-agent/examples/extensions/permission-gate.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/permission-gate.ts).
- The same first-party example presents separate **Reject** and **Abort** choices: Reject blocks the tool; Abort calls `ctx.abort()` and also returns a blocked result. Pi therefore does not inherently equate per-tool rejection with whole-turn interruption; the extension must call the abort API when that is the intended UX. Source: [`packages/coding-agent/examples/extensions/permission-gate.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/permission-gate.ts).
- Tool implementations receive an `AbortSignal`; cancellation only becomes immediate for running work when the implementation observes that signal. Pi's sandbox extension listens for abort, kills the child process, and rejects the operation. Sources: [`packages/coding-agent/src/core/extensions/types.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/extensions/types.ts) and [`packages/coding-agent/examples/extensions/sandbox/index.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts).

## Wincode decision

Wincode exposes Pi's explicit split rather than overloading one action:

- **Reject** blocks only the selected tool call while sibling approvals remain, allowing the Agent to continue with the next queued decision.
- With exactly one pending approval, **Reject** is semantically identical to Abort and the redundant Abort action is hidden.
- **Abort** rejects all sibling approvals from the conversation turn, interrupts the active chat stream immediately, and sanitizes unfinished tool calls through the existing interrupt path. It does not wait for an `input-streaming` part to become `input-available`.
- Leaving approval mode, including Escape, is also an explicit Abort.
- Policy denial and pre-send explicit-Skill rejection/abort do not interrupt a previous turn because no model stream is active for that approval.

Separate labels make scope visible only when there is a meaningful per-tool versus whole-turn choice.
