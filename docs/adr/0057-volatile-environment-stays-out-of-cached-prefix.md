# Volatile environment context stays out of the cached system prefix

Status: accepted

ADR 0017 placed a `volatile-environment` block (Git branch and working-tree status) at the end of the System Prompt so the cacheable prefix before it stayed stable. That holds for implicit prefix caching, where the provider reuses matching leading tokens. It does not hold for an explicit cache: Google `CachedContent` stores the whole `systemInstruction`, and a cached-content request may not also carry `systemInstruction` (`CachedContent can not be used with GenerateContent request setting system_instruction, tools or tool_config`). Any working-tree change therefore changed the cache identity, and the manager correctly deleted the resource and created a new one. On an active repository the status summary changes after most tool-using turns, so an explicit cache was paid for and discarded every turn. The flake in `session-host.test.ts` surfaced it: a background file create/remove between two sends made 2 of 6 runs fail.

## Decision

- `composeSystemPrompt()` no longer renders `volatile-environment` into `instructions`. It returns the block separately as `volatileContext`, wrapped in `<untrusted-environment-context>`.
- The Agent Turn delivers that context as a turn-scoped user message (`environment-context`), beside the submission's own user message, the same way an activated Skill's context is delivered.
- Transient context identifiers are owned by Agent Core (`SKILL_CONTEXT_MESSAGE_ID`, `ENVIRONMENT_CONTEXT_MESSAGE_ID`, `isTransientContextMessageId`). The runtime filters them out of the rebased model context and re-inserts each one for the current turn, so they never accumulate in history and never enter a Session Record, transcript projection, or record sanitization.
- The base safety block names environment context as untrusted contextual data, alongside Repository Project Instructions and Skill context. A branch name is repository-controlled, so it must not read as direct user intent.
- `stable-environment` remains in the System Prompt: workspace, cwd, platform, repository, worktree, provider and model do not change per turn.

## Consequences

- The System Prompt is now stable across working-tree changes for every provider. `composeSystemPrompt()` returns byte-identical instructions when only branch or status changes, and the Google CachedContent resource survives them.
- Explicit caching is still correctly invalidated by what the cached prefix genuinely contains: Agent instructions, Project Instructions, the stable environment, and the tool list.
- The model still receives current branch and status on every Model Step, including continue turns, where the context message follows the history.
- A working-tree change no longer forces a cache create/delete pair. The remaining churn is tool-set or Project Instruction changes, which genuinely change the prefix.
- Prompt Composition metadata keeps the `volatile-environment` block entry so its size stays observable, while `renderedLength` and `renderedByteLength` describe the cacheable instructions only.
