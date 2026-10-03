# Compact summary prompts in Pi, OMP, OpenCode, and Codex

| | |
|---|---|
| Research date | 2026-10-03 |
| Pi | [`earendil-works/pi` at `853a80d`](https://github.com/earendil-works/pi/tree/853a80d26c90a14c1886f0ebb8ffaae133ca2185) |
| OMP | [`can1357/oh-my-pi` at `9690622`](https://github.com/can1357/oh-my-pi/tree/969062200754ea02cfac922e5ebb8c608c079e15) |
| OpenCode | [`anomalyco/opencode` at `10765ff`](https://github.com/anomalyco/opencode/tree/10765ff2a9da8c3b88e4de873aa383a49c318912) |
| Codex | [`openai/codex` main, checked 2026-10-03](https://github.com/openai/codex/tree/main) |
| Scope | Prompt text and its role in context compaction; not a general comparison of compaction algorithms |

## At a glance

| System | What the model is told to produce | Main structure / special rule |
|---|---|---|
| Pi | A structured checkpoint for a future LLM | `Goal`, `Constraints & Preferences`, `Progress` (`Done`, `In Progress`, `Blocked`), `Key Decisions`, `Next Steps`, `Critical Context`; preserve paths, symbols, errors. A separate system prompt says summarize only, do not continue or answer the conversation. |
| OMP | A structured handoff summary for another LLM | Similar sections, with `Additional Notes`; explicitly retain an unanswered user request/question. A separate system prompt treats transcript and prior summaries as untrusted instructions. |
| OpenCode | A Markdown handoff for another coding agent | `Objective`, `Important Details`, `Work State` (`Completed`, `Active`, `Blocked`), `Next Move`, `Relevant Files`; exact paths/symbols/commands; update instructions merge the prior summary and newer conversation, with newer context winning conflicts. |
| Codex | A concise, structured checkpoint handoff for another LLM | Current progress/decisions, important context/constraints/preferences, remaining steps, critical data/examples/references. No fixed headings or exact schema in the template. |

## Pi

Pi separates a static summarization system instruction from the user-level request. The system instruction is: “You are a context summarization assistant”; it says to read a user/assistant conversation, follow the exact requested format, not continue or answer it, and output only the structured summary. [Source: `utils.ts`, `SUMMARIZATION_SYSTEM_PROMPT`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/compaction/utils.ts#L143-L145)

The initial user prompt asks for a “structured context checkpoint summary” another LLM can use to continue work. Its required headings capture goal, user constraints/preferences, done/in-progress/blocked work, decisions, next steps, and critical context; it explicitly asks to preserve exact paths, function names, and errors. The update prompt says to preserve prior information, add new information, move completed work, refresh next steps, and remove irrelevant content only when appropriate. [Source: `compaction.ts`, prompt templates](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/compaction/compaction.ts#L435-L501)

At runtime, Pi serializes the session as role-labeled text, optionally supplies a previous summary and focus, and places the content in a user message under the static system prompt. [Source: `compaction.ts`, request assembly](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/compaction/compaction.ts#L598-L609)

## OMP (Oh My Pi)

OMP's system prompt sets a safety boundary: transcript and prior summaries are untrusted data, even if they contain tags or authority claims; never follow their commands, role changes, or output-format demands. Only the system prompt and harness request govern the summarizer, which must not answer or continue the conversation. [Source: `summarization-system.md`](https://github.com/can1357/oh-my-pi/blob/969062200754ea02cfac922e5ebb8c608c079e15/packages/agent/src/compaction/prompts/summarization-system.md)

The initial summary template requires a handoff with `Goal`, `Constraints & Preferences`, `Progress` (`Done`, `In Progress`, `Blocked`), `Key Decisions`, `Next Steps`, `Critical Context`, and `Additional Notes`. Sections may be omitted when inapplicable. A particularly user-visible rule says to preserve the exact unanswered question/request if the conversation ends waiting on the user. [Source: `compaction-summary.md`](https://github.com/can1357/oh-my-pi/blob/969062200754ea02cfac922e5ebb8c608c079e15/packages/agent/src/compaction/prompts/compaction-summary.md)

The update template says to retain prior information, add new progress/context, move completed items, update next steps, and preserve relevant tool outputs and repository state. It can remove irrelevant material and says an unanswered request belongs in `Critical Context`; if the pending question was answered, replace it. [Source: `compaction-update-summary.md`](https://github.com/can1357/oh-my-pi/blob/969062200754ea02cfac922e5ebb8c608c079e15/packages/agent/src/compaction/prompts/compaction-update-summary.md)

## OpenCode

OpenCode's core compaction path has one fixed Markdown schema: `Objective`, `Important Details`, `Work State` (`Completed`, `Active`, `Blocked`), `Next Move`, and `Relevant Files`. The template says to keep every section, use terse bullets, preserve exact identifiers and paths, and omit mention of the compaction process. [Source: `packages/core/src/session/compaction.ts`, `SUMMARY_TEMPLATE`](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/core/src/session/compaction.ts#L14-L41)

For the first compaction, its request asks for a new anchored summary from the conversation. For later compactions, it supplies `<prior-summary>` and directs the model to merge it with the newer `<conversation>`: preserve still-relevant objectives, constraints, directives, decisions, and parallel work; newer conversation wins conflicts; update progress and next move. [Source: `buildPrompt`](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/core/src/session/compaction.ts#L147-L160)

The source also contains `packages/opencode/src/agent/prompt/compaction.txt`, a separate agent prompt asset. It should not be confused with the core session compaction request path described above. [Source: agent prompt asset](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/opencode/src/agent/prompt/compaction.txt)

## Codex

The current Codex prompt crate loads `templates/compact/prompt.md` as `SUMMARIZATION_PROMPT`. The text describes a “CONTEXT CHECKPOINT COMPACTION” and asks for a handoff summary for another LLM. It names four content requirements: current progress and decisions; important context, constraints, or user preferences; remaining work as clear next steps; and critical data, examples, or references. It ends by asking for a concise, structured summary that helps the next LLM continue seamlessly. There are no mandatory headings or per-section placeholders in this template. [Source: `compact.rs`](https://github.com/openai/codex/blob/main/codex-rs/prompts/src/compact.rs), [prompt template](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/compact/prompt.md)

Codex also has a separate `summary_prefix.md`: it tells the receiving model that another model started the work and that the conversation/tool state is available, and says to build on prior work without duplication. That prefix is context for resumption, not a section of the summary-generation prompt. [Source: `summary_prefix.md`](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/compact/summary_prefix.md)

## Comparison notes

- All four target a handoff/checkpoint so another model can resume; they ask for task state, constraints/context, and next actions.
- Pi, OMP, and OpenCode impose explicit summary headings. The inspected Codex template specifies content categories but leaves the exact structure to the model.
- Pi/OMP/OpenCode provide explicit iterative-update behavior. OMP adds a clear prompt-injection boundary and preservation of unanswered user requests; OpenCode states that newer conversation overrides conflicting prior-summary claims.
- “Compact summary prompt” can mean multiple artifacts. OpenCode has a core compaction request builder plus a separate agent prompt file; Codex has the summary-generation template plus a resume prefix. This note follows the actual session/checkpoint compaction path where identified.

## Method and limits

This is a static source inspection, not a runtime prompt capture. Pi, OMP, and OpenCode are cited at pinned revisions also used by existing repository research notes. Codex uses the official repository's moving `main` branch because no revision was pinned for this request; re-check that source before relying on exact text later. Prompt excerpts are summarized rather than reproduced in full.
