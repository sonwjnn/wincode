# Vertical-Slice Refactoring Playbook

Use this document when migrating layered source code or changing module boundaries.

## 1. Before editing

1. Read `../AGENTS.md`, `architecture.md`, and `architecture-profile.md`.
2. Identify the business capability and user-visible use case.
3. Inventory files, imports, public consumers, routes, tests, assets, and messages.
4. Classify each item as:
   - app composition;
   - owned by one module;
   - genuinely domain-neutral shared code.
5. Detect deep imports, reverse dependencies, and sibling-module cycles.
6. Record any required exception before implementing it.

## 2. Incremental migration

1. Move one module or use case at a time.
2. Preserve behavior and keep the application working after each step.
3. Separate mixed concerns before moving a file.
4. Move UI, logic, API integration, tests, assets, and messages into the same slice.
5. Create only directories required by existing code.
6. Establish the module public API and update consumers in the same change.
7. Use temporary compatibility re-exports only when documented with a removal condition.

Do not perform a big-bang migration unless explicitly approved. In an existing layered
project, place new behavior in business slices and migrate legacy files when that capability
is next changed.

## 3. Shared promotion review

Before moving code to `shared/`, verify:

- at least two independent modules require identical semantics, or the item is an approved
  application-wide foundation;
- the name contains no feature vocabulary;
- the code imports neither modules nor app;
- ownership and expected evolution are independent of one feature;
- all consumers and exports are updated together.

## 4. Boundary repair patterns

| Violation                                        | Repair                                                     |
| ------------------------------------------------ | ---------------------------------------------------------- |
| `shared` imports auth store                      | Inject token provider from `app/providers`                 |
| Module A and B import each other                 | Compose in app, add workflow module, or revisit boundaries |
| Consumer deep-imports module internals           | Export a minimal stable symbol from module `index.ts`      |
| Feature code lives in app-wide technical folders | Move all owned parts into its business module              |
| Module technical folder becomes large            | Split into internal use-case slices                        |
| UI directly performs raw transport work          | Move endpoint/DTO mapping into the feature API boundary    |

## 5. Verification

Run every command listed in `architecture-profile.md`, including architecture and cycle checks.

Review:

- [ ] The feature is understandable by opening one module.
- [ ] Business names appear before technical layers.
- [ ] No reverse dependency or cycle exists.
- [ ] Cross-module access uses declared public APIs.
- [ ] No speculative folder or shared abstraction was added.
- [ ] Module README and public API are current.
- [ ] Compatibility re-exports have an owner and removal condition.

## 6. Handoff report

Report:

- ownership decisions and files moved;
- public API changes;
- dependencies or cycles removed;
- temporary migration bridges;
- approved/deferred exceptions;
- verification commands and results.
