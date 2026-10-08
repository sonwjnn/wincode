# Domain Docs

How engineering skills should consume this repo's domain documentation.

## Before exploring, read these

- **`GLOSSARY-MAP.md`** at the repo root, if it exists — it points to per-context `GLOSSARY.md` files. Read the glossary relevant to the topic. If the map is absent, read the root **`GLOSSARY.md`**.
- **`CONTEXT-MAP.md`** at the repo root, if it exists — it points to per-context `CONTEXT.md` files. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. Also check `packages/<context>/docs/adr/` for context-specific decisions.

If any of these files or directories don't exist, proceed silently. Don't flag their absence or suggest creating them upfront. The `/domain-modeling` skill creates them lazily when terms or decisions are resolved.

## File structure

Multi-context repo:

```
/
├── GLOSSARY-MAP.md                    ← per-context glossary index
├── CONTEXT-MAP.md                     ← per-context context index
├── docs/adr/                          ← system-wide decisions
└── packages/
    └── <context>/
        ├── GLOSSARY.md
        ├── CONTEXT.md
        └── docs/adr/                  ← context-specific decisions
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, or a test name), use the term as defined in the relevant `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, reconsider the terminology or note the gap for `/domain-modeling`.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
