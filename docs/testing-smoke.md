# Deterministic and live TUI smoke

## Shared faux Provider

`@wincode/ai` exports `createFauxProvider`, `fauxText`, and the `Faux*` types.
It implements the real Wincode `Provider` interface without network or inference.
It is explicitly registered by the consumer, never added to the production catalog.

```ts
import { createFauxProvider, createProviderCollection, fauxText } from "@wincode/ai";

const faux = createFauxProvider({
  responses: [
    { ...fauxText("first chunk", "second chunk"), delayMs: 20 },
    ({ request }) => `Received ${request.messages.length} messages`,
  ],
});
const providers = createProviderCollection();
providers.register(faux.provider);
await providers.setCredential("faux", { kind: "faux" });
// Consume providers.chat({ providerId: "faux", modelId: "faux-1", messages: [...] }).
```

Responses are FIFO strings, event scripts, or async factories. Each instance owns
its queue and request snapshots (`calls`); `setResponses`, `appendResponses`, and
`getPendingResponseCount` control it. Exhaustion throws instead of inventing a reply.
Event scripts support reasoning, text, tool calls, usage, and continuation via the
SDK's native events. `error` throws after streamed events; `waitForAbort` holds a
request; `delayMs` is abortable. Pre-aborted requests do not consume the queue.
Tool calls use the real Agent tool runner, not simulated tool execution.

This implementation follows the Wincode Provider contract. It does not add
features that contract does not expose, such as deferred APIs, partial tool-argument
streaming, simulated token costs/cache, or random chunking. Usage is explicit.

## Automated terminal smoke (no paid requests)

```bash
bun run build:utils
bun run test:tui
```

Requires Bash, Bun and tmux. Runs the actual source CLI in a fresh workspace with
isolated HOME/XDG, credentials, Session index, and a private tmux server with an
empty tmux config. Only the owned server is stopped. OS lock failure is exit 2
(**not verified**), never success, and never grounds to kill another process.

Checks streaming chunks, cancellation reaching the Provider, recovery after
cancellation, a real read-tool roundtrip, Provider failure/recovery, preservation
of a draft at 100×30, 60×20 and 80×24, and clean `/exit`. CI gates Linux and macOS
on this smoke and uploads frames/failure logs under `test-artifacts/interactive-smoke`.
Override the output directory with `WINCODE_SMOKE_ARTIFACT_DIR`.

Project Trust is deliberately bypassed inside the generated workspace. Trust and
auth-selection UI have separate application contracts; this smoke is not evidence
that those dialogs or native Windows ConPTY work. Windows CI exercises headless
interactive startup and the Windows launchers, not a real Windows terminal.

## Release binary pipeline

`.github/workflows/release-binaries.yml` compiles the standalone executable on
Linux x64/ARM64, macOS x64/ARM64, and Windows x64. Pull requests and pushes to
`master` build and smoke the binaries; a `vX.Y.Z` tag also packages archives and
SHA-256 checksums into a GitHub **draft** Release. Publishing remains a manual
decision. A manual workflow run produces downloadable Actions artifacts without
creating a Release.

Every binary must pass isolated `--help` and `--version` checks. Linux and macOS
also run the TUI startup-and-clean-exit smoke below; it sends no Provider request.
Windows currently gets headless executable checks, not ConPTY coverage. This
pipeline verifies the compiled artifacts, but does not claim native Windows
terminal coverage.

To smoke an existing compiled executable locally:

```bash
bun run test:tui --binary /absolute/path/to/wincode
```

The binary runs in a fresh workspace with isolated user data and a bundled faux
Provider fixture. Binary mode verifies TUI startup and clean `/exit` only; the
source-mode smoke above verifies Provider streaming, cancellation, tool roundtrip,
and recovery. Bun and the checkout are needed to prepare the fixture and smoke
harness, not to execute the compiled Wincode binary. Neither smoke sends a live
Provider request.

## Opt-in live Provider smoke (can incur costs)

Never part of the PR test gate. After explicitly approving a billable request, use
the built-in Provider credentials already configured in Wincode and name the model:

```bash
bun run test:tui --live --approve-billable --model 'openai/<model-id>'
```

To exercise an existing executable, add
`--binary /absolute/path/to/wincode`. Without `--binary`, this tests the source
CLI. The script reads only the selected Provider's credential, copies it into the
isolated temporary auth store. It does not write credential data to the normal
auth store or pass Provider API-key environment variables to the TUI. Its temporary home is deleted
on exit. No live request is sent by running Default/E2E/faux smoke tests; the
live command requires both `--live` and the explicit `--approve-billable` flag.

Live mode starts the interactive TUI, submits one short prompt, waits for the
model's `smoke-live-ok` reply, and verifies clean exit. The response wait is 90
seconds; it is not a token or cost guarantee. Provider billing and availability
remain external. Live logs/frames are not uploaded or copied to faux artifacts.
This smoke does not claim cancellation, tool-call, retry, quota, or every Provider
compatibility coverage.
