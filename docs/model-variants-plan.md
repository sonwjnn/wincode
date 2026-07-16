# Model Variants Implementation Plan

## Status

Implemented. Catalog, provider options, direct/hosted transport, persistence,
restoration, rendering, `/variants`, and Google connections are complete.

Connection handling now uses the deep facade documented in
`apps/cli/src/modules/connections/README.md`; historical file lists below reflect
the original implementation plan.

## Goal

Add a `/variants` command that lets users select provider-supported reasoning
effort or thinking-budget presets for the active model.

The selected variant must:

- affect subsequent model requests;
- appear after the model provider in the prompt status bar;
- appear in persisted assistant-message metadata;
- be restored from the latest valid message when reopening a session; and
- reset to `Default` when the active model changes.

This work also expands `/models` with all compatible OpenAI, Anthropic, and
Google models listed below and adds Google API-key connections.

## Product Decisions

- `Default` is represented internally as `undefined`; it does not send a
  variant override.
- Preserve `none` only where the provider/OpenCode transform exposes it.
- Do not synthesize `none` for Anthropic effort models or budget-only models.
- Persist variant selections per session/message, not globally per model.
- Show the selected variant in both the current status bar and historical
  assistant-message footer.
- Add models to `/models`, not only to a future variant registry.
- Add Google as a direct API-key connection provider.
- Include only models compatible with the current text `LanguageModel` coding
  agent and developer function tools.
- Keep the catalog static and reviewed. Do not fetch `models.dev` at runtime.

## Variant Semantics

Supported variant identifiers:

```text
none | minimal | low | medium | high | xhigh | max
```

Variant resolution rules:

1. An explicit effort list takes precedence over toggle or budget metadata.
2. Budget-only models expose `high` and `max` presets.
3. Thinking budgets are capped by `OUTPUT_TOKEN_MAX = 32_000` and must remain
   lower than the request's maximum output tokens.
4. `Default` omits the variant override and uses provider/model defaults.
5. A persisted variant that is invalid for the restored model falls back to
   `Default`.

Provider option mapping:

| Provider | Variant type | Provider option |
| --- | --- | --- |
| OpenAI | effort | `reasoningEffort` |
| Anthropic | adaptive effort | `thinking.type = "adaptive"` and `effort` |
| Anthropic | token budget | `thinking.type = "enabled"` and `budgetTokens` |
| Google | effort | `thinkingConfig.thinkingLevel` |
| Google | token budget | `thinkingConfig.thinkingBudget` |

## OpenAI Catalog

Add 31 compatible models under direct `openai` connection selection.

| Variants | Models |
| --- | --- |
| `low`, `medium`, `high` | `o3`, `o4-mini`, `o3-pro`, `o3-mini`, `o1`, `o1-pro`, `gpt-5.1-codex`, `gpt-5-codex` |
| `medium`, `high`, `xhigh` | `gpt-5.2-pro`, `gpt-5.4-pro`, `gpt-5.5-pro` |
| `none`, `low`, `medium`, `high`, `xhigh`, `max` | `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` |
| `minimal`, `low`, `medium`, `high` | `gpt-5`, `gpt-5-mini`, `gpt-5-nano` |
| `high` | `gpt-5-pro` |
| `none`, `low`, `medium`, `high`, `xhigh` | `gpt-5.4-nano`, `gpt-5.3-codex-spark`, `gpt-5.2`, `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5` |
| `low`, `medium`, `high`, `xhigh` | `gpt-5.1-codex-max`, `gpt-5.2-codex` |
| `medium` | `gpt-5.1-chat-latest`, `gpt-5.2-chat-latest` |
| `none`, `low`, `medium`, `high` | `gpt-5.1` |

Exclude these OpenAI models:

| Model | Reason |
| --- | --- |
| `gpt-realtime-2.1` | Requires Realtime API session transport. |
| `o3-deep-research` | Does not support developer-defined function tools. |
| `o4-mini-deep-research` | Does not support developer-defined function tools. |

## Anthropic Catalog

Add 12 compatible models under direct `anthropic` connection selection.

| Variants | Models |
| --- | --- |
| `low`, `medium`, `high` | `claude-opus-4-5`, `claude-opus-4-5-20251101` |
| `low`, `medium`, `high`, `xhigh`, `max` | `claude-opus-4-7`, `claude-sonnet-5`, `claude-opus-4-8`, `claude-fable-5` |
| `low`, `medium`, `high`, `max` | `claude-opus-4-6`, `claude-sonnet-4-6` |
| `high = 16_000`, `max = 31_999` | `claude-haiku-4-5`, `claude-haiku-4-5-20251001`, `claude-sonnet-4-5`, `claude-sonnet-4-5-20250929` |

Exclude deprecated Anthropic models:

- `claude-opus-4-1`
- `claude-opus-4-1-20250805`

Important resolver correction: the current Sonnet 5 and Opus 4.8 configuration
uses manual thinking. These models require adaptive thinking for effort-based
reasoning, so their existing provider options must be corrected as part of this
work.

## Google Catalog

Add 11 compatible models under direct `google` connection selection.

| Variants | Models |
| --- | --- |
| `minimal`, `low`, `medium`, `high` | `gemini-3.1-flash-lite`, `gemini-3.5-flash`, `gemini-3-flash-preview` |
| `low`, `medium`, `high` | `gemini-3.1-pro-preview` |
| `low`, `high` | `gemini-3-pro-preview` |
| `high = 16_000`, `max = 31_999` | `gemini-2.5-pro` |
| `high = 12_288`, `max = 24_576` | `gemini-2.5-flash`, `gemini-flash-latest`, `gemini-flash-lite-latest`, `gemini-2.5-flash-lite` |
| No transformed variants | `gemma-4-31b-it` |

Exclude these Google models:

| Model | Reason |
| --- | --- |
| `gemini-3.1-pro-preview-customtools` | Requires a custom-tool format not used by the current coding-agent tools. |
| `gemini-3.1-flash-image-preview` | Uses the image-generation path instead of the current text tool loop. |
| `gemini-3.1-flash-lite-preview` | Deprecated preview model. |

Google toggle metadata does not produce a `none` variant for
`@ai-sdk/google` under the referenced OpenCode transform. Budget metadata still
produces `high` and `max`.

## Catalog Result

- 31 direct OpenAI models.
- 12 direct Anthropic models.
- 11 direct Google models.
- 2 existing hosted Wincode selections retained.
- Approximately 56 total model selections, including hosted/direct duplicates.

## Implementation Plan

### 1. Shared Model and Variant Contracts

Primary files:

- `packages/ai/src/models.ts`
- `packages/ai/src/message.ts`
- `packages/ai/src/shared.ts`

Work:

- Add `google` to connection-provider IDs and validation.
- Add all approved catalog entries with explicit display names, provider IDs,
  model IDs, and variant definitions.
- Add a Zod-backed `ModelVariant` type.
- Add helpers to list and validate variants for a model selection.
- Keep `Default` outside the variant enum as `undefined`.
- Add optional `variant` to `CodingMessageMetadata`.
- Preserve type-safe model selection without unchecked assertions.
- Revisit the large literal Zod union if catalog expansion causes TypeScript or
  runtime complexity; prefer an object schema plus catalog refinement if needed.

### 2. Provider Resolution

Primary files:

- `packages/ai/src/server/models.ts`
- `packages/ai/src/server/agent.ts`
- `packages/ai/src/server/stream.ts`

Work:

- Extend direct model resolution to Google through
  `createGoogleGenerativeAI({ apiKey })`.
- Resolve the correct OpenAI model API mode for Responses-only and chat models.
- Merge selected variants with required base provider options.
- Preserve `store: false` and encrypted reasoning state where required for
  stateless OpenAI Responses conversations.
- Use adaptive thinking for compatible Anthropic models.
- Use manual token budgets only for budget-based Anthropic models.
- Pass an explicit maximum output-token limit when a thinking budget requires
  it, ensuring `budgetTokens < maxOutputTokens`.
- Reject unsupported model/variant combinations before provider invocation.

### 3. Google Connection

Primary files:

- `apps/cli/src/modules/connections/types.ts`
- `apps/cli/src/modules/connections/storage.ts`
- `apps/cli/src/modules/connections/connect-provider.ts`
- `apps/cli/src/modules/connections/service.ts`
- `apps/cli/src/modules/connections/ui/connection-dialog-options.ts`
- `apps/cli/src/app/commands/use-app-command-executor.tsx`

Work:

- Add Google API-key credential schema and storage typing.
- Add Google to `/connect` with API-key method only.
- Validate credentials against Google's models endpoint using
  `x-goog-api-key`.
- Include Google in connected-provider status loading.
- Keep existing secure-secret storage behavior and permission checks.
- Never include credentials in errors, logs, metadata, or persisted messages.

### 4. Direct Chat Routing

Primary files:

- `apps/cli/src/modules/conversations/hooks/local-chat-transport.ts`
- `apps/cli/src/modules/conversations/hooks/routing-chat-transport.ts`
- `apps/cli/src/modules/conversations/api/chat-request.ts`

Work:

- Route `openai`, `anthropic`, and `google` selections through local transport.
- Load and validate Google API-key credentials before model creation.
- Thread the active variant through local model resolution.
- Keep `wincode` selections on hosted Hono transport.
- Add variant to hosted requests for the two retained hosted selections.
- Ensure direct selections never enter the hosted-only request-body guard.

### 5. Prompt Configuration

Primary file:

- `apps/cli/src/modules/prompt-settings/context/prompt-config-provider.tsx`

Work:

- Add `variant` and `setVariant` to prompt configuration.
- Reset variant to `Default` only when model provider/model ID changes.
- Restore model and variant together from session metadata.
- Keep imperative keyboard callbacks synchronized with refs where required by
  OpenTUI.

### 6. `/variants` Command and Dialog

Primary files:

- `apps/cli/src/modules/commands/commands.ts`
- `apps/cli/src/modules/commands/execute-command.ts`
- `apps/cli/src/modules/commands/adapters/`
- `apps/cli/src/app/commands/use-app-command-executor.tsx`
- `apps/cli/src/modules/prompt-settings/ui/variants-dialog.tsx`

Work:

- Add a `variants` command kind and `/variants` registry entry.
- Add a variants adapter following the existing models adapter pattern.
- Open a searchable `Select Variant` dialog.
- Render `Default` first, followed by model-supported variants in increasing
  effort/budget order.
- Mark the current selection with the existing bullet convention.
- Close on selection or Escape.
- Show `No variants available` for models such as `gemma-4-31b-it`.

### 7. Request Metadata and Persistence

Primary files:

- `apps/cli/src/modules/conversations/hooks/use-chat.ts`
- `apps/cli/src/modules/conversations/utils.ts`
- `apps/cli/src/modules/conversations/storage/conversation-store.ts`
- `apps/cli/src/modules/conversations/storage/drizzle-conversation-store.ts`
- `apps/server/src/routes/sessions.ts`

Work:

- Add variant to submit, continuation, interrupt, and finalization paths.
- Add optional variant to the hosted chat request schema.
- Validate variant against the requested hosted model.
- Persist variant inside existing metadata JSON.
- Restore the latest valid variant when loading a session.
- Do not add a database migration; the existing JSON metadata column can hold
  the optional field.

### 8. Metadata Rendering

Primary files:

- `apps/cli/src/modules/prompt-settings/ui/prompt-status-bar.tsx`
- `apps/cli/src/modules/conversations/ui/messages/bot-message.tsx`
- `apps/cli/src/modules/conversations/ui/components/chat-turns.ts`

Target format:

```text
Plan · GPT-5.6 Sol openai · high
```

Work:

- Render the active variant after model/provider in the status bar.
- Render persisted variant after model/provider and before response time in the
  assistant footer.
- Do not render `Default` when no explicit variant is selected.
- Include variant in the turn-footer metadata signature so turns with different
  variants are not incorrectly collapsed.

### 9. Documentation

Update:

- `apps/cli/src/modules/commands/README.md`
- `apps/cli/src/modules/connections/README.md`
- relevant conversation and prompt-settings module documentation

Document:

- `/variants` behavior;
- Google API-key connection;
- static catalog policy;
- `Default` semantics; and
- model compatibility exclusions.

## Test Plan

Use table-driven tests for the expanded catalog and variant matrix.

Required coverage:

- every included model resolves to the expected provider and variant list;
- every excluded model is absent from `/models`;
- effort variants generate correct provider options;
- budget variants generate exact numeric budgets;
- budget never equals or exceeds maximum output tokens;
- invalid model/variant combinations are rejected;
- `none` is preserved only for listed models;
- model changes reset variant to `Default`;
- session reload restores the latest valid variant;
- `/variants` registry, adapter, executor, and dialog selection work;
- Google API-key validation and secret storage work;
- Google direct requests route locally;
- hosted Wincode requests carry and validate variants;
- status bar and assistant footer render metadata in the required order; and
- metadata signature changes when variant changes.

Primary test locations:

- `packages/ai/src/models.test.ts`
- `packages/ai/src/server/models.test.ts`
- `apps/cli/src/modules/commands/*.test.ts`
- `apps/cli/src/modules/connections/*.test.ts`
- `apps/cli/src/modules/conversations/**/*.test.ts`
- `apps/server/src/routes/sessions.test.ts`

## Verification

Run after implementation:

```bash
bun x ultracite fix
bun run --cwd packages/ai check-types
bun run --cwd apps/cli check-types
bun test packages/ai/src
bun test apps/cli/src
bun test apps/server/src
bun run check
```

## Acceptance Criteria

- `/models` lists every included model under the correct connection provider.
- Excluded incompatible/deprecated models do not appear.
- `/connect` can securely add and validate a Google API key.
- `/variants` shows only variants valid for the active model.
- Selecting a variant changes the provider request options.
- `none` remains selectable where explicitly supported.
- `Default` sends no explicit variant override.
- Model changes reset the selected variant.
- Session reload restores model and valid variant metadata.
- Status bar and assistant footer show the selected variant after provider.
- Hosted and direct transports behave consistently.
- All type checks, tests, and Ultracite checks pass.

## Reference Sources

- OpenCode provider transform:
  <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/transform.ts>
- Models.dev catalog: <https://models.dev/api.json>
- OpenAI model and reasoning docs: <https://developers.openai.com/api/docs/models>
- Anthropic effort docs:
  <https://platform.claude.com/docs/en/build-with-claude/effort>
- Anthropic adaptive thinking docs:
  <https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking>
- Google thinking docs: <https://ai.google.dev/gemini-api/docs/thinking>
- Google function-calling docs:
  <https://ai.google.dev/gemini-api/docs/function-calling>
