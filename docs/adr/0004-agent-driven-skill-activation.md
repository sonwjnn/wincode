# Agent-Driven Skill Activation

Wincode lets an Agent activate local Skills on demand through a native `skill` tool while
retaining explicit `/skill-name` invocation. Skill instructions augment one user turn as
untrusted context; they never become system instructions, persist into later turns, or
expand the Agent's Tool Permission.

Status: accepted

## Considered Options

- **Model selection over keyword rules or a preflight router** - the active Agent decides
  whether a prompt benefits from a Skill. Base guidance strongly encourages conditional
  use, but simple prompts do not require a Skill lookup.
- **A visible metadata catalog over search and embeddings** - the local catalog is
  expected to contain only dozens of Skills. The `skill` tool description therefore
  lists the name and description of each permitted Skill, and the model loads one by
  exact name. Search, embedding indexes, and router-model latency are deferred until
  measured catalog size or selection quality warrants them.
- **One native `skill` tool over separate search and load tools** - a single tool matches
  the OpenCode ecosystem contract and progressively discloses the full Skill body only
  after selection. The CLI executes the tool because it owns the local filesystem,
  discovery precedence, permissions, and Skill contents; hosted servers receive neither
  raw permission rules nor a copy of the catalog.
- **Turn-scoped snapshots over session persistence** - activation snapshots the current
  body and content hash for the rest of one Primary Agent or Subagent execution turn.
  Compaction preserves that snapshot until the turn ends. A later turn discovers and
  snapshots again; a crashed turn is marked interrupted and retry starts a new execution
  rather than reconstructing lost instructions.
- **Permission composition over implicit trust** - both explicit and Agent-initiated
  activation evaluate the `skill` permission action. Bundled resources use the ordinary
  file and shell tools; paths outside the workspace additionally evaluate
  `external_directory`. Loading a Skill grants neither filesystem access nor execution
  rights.

## Consequences

- At the start of each execution turn, Wincode discovers Skills and snapshots the
  effective catalog after Agent-specific Permission Rules are applied. Parsed files may
  be cached by path and file metadata. Changes become visible at the next turn, never in
  the middle of the current turn.
- The `skill` tool is available to Primary Agents and Subagents when at least one Skill is
  not denied. Its description contains the permitted `<available_skills>` entries. A
  denied Skill is hidden; an `ask` Skill remains visible and uses the generic
  allow-once/always/reject approval flow. Skill access defaults to `allow`.
- An execution may activate at most three distinct Skills. Explicit activation consumes
  one slot. Re-loading an active Skill is idempotent; rejected or failed loads consume no
  slot. A fourth distinct load returns a non-retryable `SKILL_LIMIT_REACHED` error and no
  Skill can be unloaded or replaced because its instructions have already entered model
  context. A Skill may recommend another Skill, but the Agent must select it and all
  normal limits and permissions still apply.
- `/skill-name arguments` resolves and authorizes before the first model call, then
  injects the Skill immediately. Arguments belong only to explicit activation; the
  native tool accepts only a Skill name. Rejecting explicit activation keeps the input
  and attachments and sends no prompt. Retry is a new execution and evaluates permission
  again.
- Instruction precedence is immutable Wincode safety and Tool Permission, direct user
  intent, active Agent instructions, explicit Skill instructions, then Agent-loaded
  Skill instructions. Load order does not resolve conflicts between Agent-loaded Skills;
  the Agent follows user intent or asks for clarification. Skill context is wrapped with
  its name, source, and content hash and is never appended to the system prompt.
- Successful activation persists only metadata: name, content hash, source
  (`explicit` or `agent`), and explicit arguments where applicable. Explicit activation
  belongs to the user message; Agent activation belongs to the assistant message that
  contains the tool call. Raw bodies and raw tool results are not stored. Existing
  records containing instructions remain readable but new writes use metadata only.
- The live model loop receives the full body, while durable tool state contains a
  sanitized result. Telemetry records only name, source, content hash, status, and
  duration; it excludes instructions, arguments, absolute paths, and bundled resource
  contents. The UI presents Agent activation as an expandable activity row with approval,
  loaded, rejected, or failed state. Rejecting an Agent load does not abort the turn but
  prevents retrying that Skill during the same execution.
- The tool result includes the absolute Skill base directory and a sample of bundled
  resource paths. Agents use existing read, list, grep, write, edit, and shell tools for
  those resources. External paths require `external_directory` permission in addition
  to the underlying operation permission; it defaults to `ask`, uses canonical absolute
  paths, and evaluates resolved symlink targets.
- Validation caps Skill names at 64 characters, descriptions at 1,024 characters
  (matching the frontmatter contract), bodies at 12,000 characters, sampled resource
  paths at 1,024 characters each, and resource samples at ten paths. The
  permission-filtered catalog is capped at 24 KiB of UTF-8.
  Individual invalid Skills are omitted with diagnostics; an oversized catalog disables
  the tool with a diagnostic rather than truncating model-visible content.
