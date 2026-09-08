# System-prompt architecture Resources

## Knowledge

- [Pi: `buildSystemPrompt()` at revision `853a80d`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/system-prompt.ts#L1-L160)
  Primary implementation of Pi's single-string prompt assembly: default/custom base, tool snippets, guidelines, append text, project context, skills, and cwd.
- [Pi: prompt templates and context loading](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/prompt-templates.ts#L104-L239)
  Shows that slash-command Markdown templates are a separate feature from the normal system prompt, while context files are loaded through a distinct resource path.
- [OMP: system-prompt customization guide at revision `9690622`](https://github.com/can1357/oh-my-pi/blob/969062200754ea02cfac922e5ebb8c608c079e15/docs/system-prompt-customization.md#L1-L80)
  First-party explanation of default/custom system prompts, append behavior, project footer, and customization files.
- [OMP: default system template](https://github.com/can1357/oh-my-pi/blob/969062200754ea02cfac922e5ebb8c608c079e15/packages/coding-agent/src/prompts/system/system-prompt.md)
  The primary Markdown/Handlebars template containing role, workflow, tool policy, skills, rules, verification, and delivery sections.
- [OMP: prompt builder](https://github.com/can1357/oh-my-pi/blob/969062200754ea02cfac922e5ebb8c608c079e15/packages/coding-agent/src/system-prompt.ts#L680-L1040)
  Traces dynamic preparation, template variables, conditional tool inventory, cache-aware workspace data, and ordered provider-facing blocks.
- [OpenCode: provider prompt selection](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/opencode/src/session/system.ts#L1-L42)
  Primary mapping from provider/model families to static `.txt` system-prompt assets.
- [OpenCode: request preparation](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/opencode/src/session/llm/request.ts#L50-L111)
  Shows how agent/provider base prompts, dynamic system blocks, user system text, and provider-specific transport are combined.
- [OpenCode: turn prompt assembly](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/opencode/src/session/prompt.ts#L1252-L1286)
  Shows the runtime order for environment, discovered instructions, MCP instructions, skills, and structured-output directives.
- [OpenCode: tool resolution](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/opencode/src/session/tools.ts#L50-L116)
  Demonstrates that tool descriptions and input schemas are sent as AI SDK tools rather than duplicated in the textual system base.
- [Wincode comparison research note](docs/research/system-prompt-pi-omp-opencode-wincode.md)
  Local pinned-source synthesis with composition matrices, compaction comparison, and explicitly marked recommendations for Wincode.

## Wisdom (Communities)

- No community resource selected yet. The first sessions stay source-first; a practitioner community can be added when the user wants feedback on a concrete Wincode design.

## Gaps

- The compared projects expose implementation choices, not a shared formal standard for system-prompt composition. Later lessons should treat their patterns as evidence and trade-offs, not a universal specification.
