# Pi global settings dialog and auto-compact — research note

| | |
|---|---|
| Pi source | Maintained [`earendil-works/pi`](https://github.com/earendil-works/pi) repository |
| Pi revision | [`853a80d26c90a14c1886f0ebb8ffaae133ca2185`](https://github.com/earendil-works/pi/tree/853a80d26c90a14c1886f0ebb8ffaae133ca2185) |
| Pi commit date | `2026-08-28T23:56:06+02:00` |
| Scope | Interactive settings UI, extensibility shape, persistence scope, and auto-compaction separation |

## Executive answer

Pi uses one `/settings` selector rather than a separate dialog for each preference. The selector is a scrollable, searchable list. A row can cycle through string values or open a submenu; changing a row invokes a callback immediately. Auto-compact is one ordinary row in that list, currently the first row. ([`/settings` dispatch](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2978-L2992), [`SettingsSelectorComponent`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/modes/interactive/components/settings-selector.ts#L437-L464), [`SettingsList`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/tui/src/components/settings-list.ts#L182-L239))

Pi's durable settings model has two built-in file scopes: global `~/.pi/agent/settings.json` and project `.pi/settings.json`. Project settings override global settings, including nested fields. The built-in auto-compaction setter writes the global settings layer; a project value can still mask that global value in the effective configuration. ([settings paths and precedence](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/docs/settings.md#L1-L10), [nested project override](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/docs/settings.md#L348-L369), [`setCompactionEnabled`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/settings-manager.ts#L829-L855))

Pi stores the generated compaction result in the session history, not as a snapshot of the preference that triggered it. The setting is read at runtime; the resulting `CompactionEntry` contains summary/boundary/token metadata and is persisted to the session file when persistence is enabled. ([runtime threshold check](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/agent-session.ts#L543-L559), [`CompactionEntry`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/session-manager.ts#L69-L80), [session append/persistence](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/session-manager.ts#L1016-L1050))

## Pi facts

### 1. The settings surface is a list with immediate mutations

The reusable TUI contract is `SettingItem`:

- `id`: stable setting identifier
- `label`: visible name
- `description`: text shown for the selected row
- `currentValue`: displayed value
- `values`: optional values cycled by Enter/Space
- `submenu`: optional nested selector opened by Enter/Space

`SettingsList` owns selection, scrolling, optional fuzzy search, submenu lifecycle, and Escape cancellation. It updates the row before calling `onChange(id, newValue)`, so the UI interaction is immediate rather than a Save/Cancel batch form. ([`SettingItem` contract](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/tui/src/components/settings-list.ts#L7-L24), [constructor/search state](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/tui/src/components/settings-list.ts#L38-L72), [keyboard behavior](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/tui/src/components/settings-list.ts#L182-L239), [rendered description/hints](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/tui/src/components/settings-list.ts#L104-L179))

For a complex value, Pi composes the same shell with a titled `SelectSubmenu`. Multi-step values use `SteppedSubmenu`; each step can compute its options from previous selections, preselect a value, support search, and go back with Escape. ([`SelectSubmenu`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/modes/interactive/components/settings-submenu.ts#L20-L138), [`SteppedSubmenu`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/modes/interactive/components/settings-submenu.ts#L144-L258))

The active interactive mode recognizes the exact `/settings` input, clears the editor, builds the selector, and focuses its settings list. ([command handling](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2978-L2992), [selector mounting/focus](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4539-L4545), [selector return/focus](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4761-L4772))

### 2. Auto-compact is an ordinary settings row

`SettingsSelectorComponent` puts Auto-compact in the `SettingItem[]` with id `autocompact`, a boolean display value, and the description “Automatically compact context when it gets too large.” The row uses `values: ["true", "false"]`, so it does not need a custom dialog. ([Auto-compact row](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/modes/interactive/components/settings-selector.ts#L457-L464))

The change handler maps that row id to `onAutoCompactChange`. The interactive mode callback calls `session.setAutoCompactionEnabled(enabled)` and updates the footer immediately. ([row handler](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/modes/interactive/components/settings-selector.ts#L819-L839), [interactive callback](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4545-L4591))

The durable compaction schema contains three fields: `enabled` (default `true`), `reserveTokens` (default `16384`), and `keepRecentTokens` (default `20000`). The settings documentation describes `compaction.enabled` specifically as enabling auto-compaction. ([schema](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/settings-manager.ts#L13-L17), [documented compaction settings](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/docs/settings.md#L114-L129))

Manual compaction remains a separate action: the compaction documentation distinguishes automatic threshold-triggered compaction from `/compact [instructions]`. Disabling auto-compaction does not remove the manual operation. ([compaction triggers](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/docs/compaction.md#L25-L40), [manual behavior when disabled](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/docs/compaction.md#L410-L418))

### 3. Pi's settings UI contract is typed, but not a plugin registry

The component receives a large `SettingsConfig` object and a large `SettingsCallbacks` object. The constructor creates one static `SettingItem[]`, then uses a switch on row ids to dispatch each mutation. ([`SettingsConfig`/`SettingsCallbacks`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/modes/interactive/components/settings-selector.ts#L49-L127), [static item list](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/modes/interactive/components/settings-selector.ts#L457-L709), [id switch](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/modes/interactive/components/settings-selector.ts#L819-L936))

**[INFERENCE]** Adding a simple Pi setting normally touches several places: the settings type/config payload, callback interface, static item construction, id switch, and the interactive-mode callback wiring. Pi's reusable part is the list/submenu interaction contract; the application-level setting catalog is still explicit code, not a runtime registry. ([same typed contracts](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/modes/interactive/components/settings-selector.ts#L49-L127), [same construction/dispatch](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/modes/interactive/components/settings-selector.ts#L443-L464), [same callback switch](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/modes/interactive/components/settings-selector.ts#L822-L936))

### 4. Global/project persistence is separate from session state

Pi's settings manager loads a global file and, when project trust permits it, a project file. The effective settings are a deep merge with project values taking precedence. ([manager construction and paths](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/settings-manager.ts#L336-L408), [project trust and reload merge](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/settings-manager.ts#L497-L553), [documented precedence](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/docs/settings.md#L348-L369))

The normal save path queues a write, uses per-scope modification tracking, and merges changed fields with the current file contents while holding the storage lock. This preserves unrelated settings changed in the file between reads. ([write queue/error handling](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/settings-manager.ts#L598-L610), [scoped persistence](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/settings-manager.ts#L620-L681))

`setCompactionEnabled()` specifically mutates `globalSettings.compaction.enabled`, records the nested field as modified, and invokes the global save path. Its getter reads the effective merged settings, so a project setting can still win over the value written globally. ([setter/getter](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/settings-manager.ts#L829-L855))

### 5. The preference and the compaction result have different lifetimes

The agent session reads the current compaction settings when checking whether context should compact and when running automatic compaction. The threshold decision is runtime behavior, not a session metadata field. ([pre-response threshold check](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/agent-session.ts#L543-L559), [threshold-triggered execution](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/agent-session.ts#L2225-L2229))

When compaction succeeds, Pi appends a `CompactionEntry` containing the generated summary, the first kept entry, token count, and optional details/usage. `_persist()` writes session entries to the session JSONL file when the session is persistent. ([entry fields](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/session-manager.ts#L69-L80), [append method](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/session-manager.ts#L1097-L1120), [persistence guard](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/session-manager.ts#L1016-L1043))

An in-memory session disables session-file persistence, but this does not change the durable settings model. ([in-memory session](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/session-manager.ts#L1569-L1572))

## Implications for Wincode

These are recommendations derived from the Pi source and the stated Wincode goal; they are not claims that Wincode already behaves this way.

### Recommended product contract

1. **One global Settings hub.** Expose `/settings` from Home and an active session. The hub should remain available without a conversation. Keep `/compact` as an active-session command because it performs a session operation, not a preference edit.
2. **Auto-compact as a normal row.** Put `Auto-compact` under a `Compaction` section in the global hub. Toggle immediately, close with Escape, and show the persisted/effective value after the write completes.
3. **Keep manual compaction separate.** A settings toggle controls future automatic threshold checks; it should not rewrite compaction history or alter existing summaries.
4. **Use a nested namespace.** Persist the preference as a stable nested key such as `compaction.auto` (or preserve the repository's already-established key if it differs). Keep generated compaction summaries/boundaries in session storage.
5. **Make scope explicit.** If the product decision is truly user-global, write explicitly to the global config source. Do not silently preserve project precedence while labeling the control “global.” If project overrides are required later, add an explicit source/override affordance rather than hiding precedence in the toggle.

### Recommended implementation shape

Pi demonstrates a good interaction primitive but not a complete extensibility registry. For Wincode, use a small typed static registry/descriptor layer above the existing dialog primitives:

```ts
type SettingDescriptor = {
  id: string;
  section: string;
  label: string;
  description: string;
  kind: "boolean" | "select" | "custom";
  read: () => string;
  write: (value: string) => Promise<void>;
  reset?: () => Promise<void>;
};
```

The descriptor should own display metadata and persistence semantics; the generic dialog should own navigation, rendering, focus, Escape, and error presentation. A custom renderer should be available for settings that need validation or multiple steps. Do not build a runtime plugin system or an arbitrary JSON-form generator until a real setting needs it.

When a new setting is added, the desired change should be one descriptor plus its typed config/read/write implementation. This avoids the callback-interface and id-switch fan-out visible in Pi while keeping the setting catalog statically reviewable. The descriptor layer is a Wincode recommendation, not a Pi API.

### Suggested initial boundary

Start with one persisted global row:

- Section: `Compaction`
- Label: `Auto-compact`
- Type: boolean
- Default: existing Wincode default
- Mutation: immediate global config write
- Reset: remove the explicit key and resolve the default
- Session effect: subsequent automatic compaction checks observe the effective value
- No session-history mutation

Add reserve/recent-token controls only after their validation, model/context-window behavior, and global-vs-project scope are defined. Pi exposes those fields in its settings schema, but their presence in the schema does not require exposing every field in the first UI. ([Pi compaction schema](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/settings-manager.ts#L13-L17), [runtime compaction calculation](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/docs/compaction.md#L27-L47))

If Wincode keeps `/compaction` for discoverability or compatibility, make it a deep-link into `Settings > Compaction`; it should not maintain a second settings state or a separate persistence path.

## Source manifest

- [Pi settings documentation](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/docs/settings.md)
- [Pi compaction documentation](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/docs/compaction.md)
- [Interactive settings selector](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/modes/interactive/components/settings-selector.ts)
- [Reusable TUI settings list](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/tui/src/components/settings-list.ts)
- [Settings submenus](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/modes/interactive/components/settings-submenu.ts)
- [Interactive mode command/callback wiring](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/modes/interactive/interactive-mode.ts)
- [Settings manager](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/settings-manager.ts)
- [Agent session compaction runtime](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/agent-session.ts)
- [Session entry persistence](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/session-manager.ts)

## Uncertainties and limits

- This note pins Pi revision `853a80d26c90a14c1886f0ebb8ffaae133ca2185`; Pi's `main` branch can change after that revision.
- Pi's interactive `/settings` surface is implemented inside the active interactive mode. Exposing the same concept from a Home view is a Wincode product adaptation, not a direct Pi behavior claim.
- Pi has global and project settings. The recommendation to make Wincode's first settings row explicitly global intentionally narrows that model; it should not be implemented by accidentally relying on whichever merged config source happens to win.
- The descriptor/registry design in the Wincode section is a design recommendation based on the observed typed callback fan-out; it is not an abstraction present in Pi.
