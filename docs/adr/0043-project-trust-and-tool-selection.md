---
status: accepted
---

# Trust Protected Project Resources and Select Tools, Not Calls

Because project configuration can start MCP processes or load executable Plugins, Wincode gates protected project configuration and resources on user-owned canonical directory trust before loading them; interactive TTY sessions may prompt, but non-interactive modes and SDK callers never infer trust. Trust is directional (ancestors authorize descendants, not vice versa), `AGENTS.md` remains ungated untrusted guidance, and trusted code retains Wincode's operating-system privileges, so Project trust is not a sandbox; this decision supersedes conflicting project-resource trust or per-call Tool Permission choices in ADR-0005, ADR-0008, ADR-0036, ADR-0040, and ADR-0041 while preserving accepted Plugin package ownership, public Session SDK, and CLI distribution boundaries. Wincode removes its per-call `allow`/`ask`/`deny` layer: Agent tool selection controls exposure, capability ceilings restrict delegated Sessions, and resource profiles bound coding-tool operations.
