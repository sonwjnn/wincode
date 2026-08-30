# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

- **The `list` coding tool is removed; discovery is glob plus the Read Tool.**
  Agents locate unknown paths with the read-only `glob` tool (ripgrep-backed,
  gitignore-aware, hidden files off by default, mtime-ordered, bounded) and
  inspect known directories through the Read Tool's bounded two-level text
  tree with Line Range Selector continuation. `list` is gone from the coding
  tool catalog, server declaration, local dispatcher, Agent-visible manifests,
  Tool Gate, and resource profiles; stale `list` names in hosted descriptors
  or permission rules produce the existing unknown-tool diagnostic and are
  never aliased or silently removed. Permission Rule action globs remain
  valid under ADR-0003, and content grep is unchanged.

- **Shell permission flips to a permissive posture (0.1.0).** Shell commands
  default to `allow` instead of `ask`; `rm *` and `sudo *` deny by default as
  overridable rules. Commands are matched as string globs and evaluated per
  command node via a tree-sitter parse (fail-closed), cd-family nodes are
  exempt, "Always allow" records the exact normalized command, and a doom_loop
  guard asks on the third identical tool call. The manual-approval safety
  ceiling is unchanged. See ADR-0008.

- **Read output is line-addressed.** Text reads now prefix every line with its
  1-indexed line number. Read targets accept Oh My Pi-compatible single and
  multi-range selectors, preserve literal colon-containing paths, add bounded
  code context, and return a continuation selector when the output byte limit
  is reached.

### Features

- **Tool resource profiles are configurable.** Set `resource_limits` to
  `standard`, `extended`, or `deep` globally or per Agent in `wincode.json(c)`.
  Elevated profiles allow larger bounded reads, searches, listings, shell
  commands, and edit previews; the first elevated call requests approval.
