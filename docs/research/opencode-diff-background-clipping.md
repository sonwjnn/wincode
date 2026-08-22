# OpenCode conversation edit diff background clipping — research note

| | |
|---|---|
| Research date | 2026-08-22 |
| OpenCode revision | [`e00890c67261a435cee6409366a68999a93393fd`](https://github.com/anomalyco/opencode/tree/e00890c67261a435cee6409366a68999a93393fd) (`opencode` 1.18.21) |
| OpenTUI revision | [`0c8c4f7cff2927e3df63a9757a45eff9a343611c`](https://github.com/anomalyco/opentui/tree/0c8c4f7cff2927e3df63a9757a45eff9a343611c), behind `@opentui/core@0.4.5` / `v0.4.5` |
| Wincode comparison revision | [`0d0677cbf2a83a87f4199fb299a69d1918a05984`](https://github.com/sonwjnn/wincode/tree/0d0677cbf2a83a87f4199fb299a69d1918a05984) |
| Scope | Diagnosis and implementation verification — OpenTUI source comparison, minimized renderer reproduction, focused ChatShell regressions, and a committed OpenTUI patch |

---

## Executive conclusion

**Verified:** OpenCode has **no app-level framebuffer cleanup** for conversation diff backgrounds. It directly composes OpenTUI `DiffRenderable` (`<diff>`) below `ScrollBoxRenderable` (`<scrollbox>`). OpenCode selects split/unified layout and passes theme colors; OpenTUI 0.4.5 clips through an `overflow: "hidden"` viewport, nested scissor commands, and the scissor-aware native `fillRect` used for full-row diff backgrounds. See the [conversation viewport](https://github.com/anomalyco/opencode/blob/e00890c67261a435cee6409366a68999a93393fd/packages/tui/src/routes/session/index.tsx#L1180-L1204), [conversation edit](https://github.com/anomalyco/opencode/blob/e00890c67261a435cee6409366a68999a93393fd/packages/tui/src/routes/session/index.tsx#L2394-L2436), [permission diff](https://github.com/anomalyco/opencode/blob/e00890c67261a435cee6409366a68999a93393fd/packages/tui/src/routes/session/permission.tsx#L45-L79), [ScrollBox viewport](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/renderables/ScrollBox.ts#L326-L351), [scissor traversal](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/Renderable.ts#L1413-L1460), and [clipped `fillRect`](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/zig/buffer.zig#L921-L953).

**Upstream behavior:** OpenTUI's `DiffRenderable` builds `CodeRenderable` children inside `LineNumberRenderable` lanes. `LineNumberRenderable.renderSelf` paints content backgrounds with `buffer.fillRect`; its gutter paints separately with the same primitive. The viewport scissor clips these fills; OpenCode does not erase them afterward. [Diff child construction](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/renderables/Diff.ts#L378-L470), [content fill](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/renderables/LineNumberRenderable.ts#L526-L553), [gutter fill](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/renderables/LineNumberRenderable.ts#L243-L295).

**Inference:** This renderer-level path explains why OpenCode needs no Wincode-style viewport-edge repaint. It does not prove every OpenTUI primitive clips correctly: first-party [issue #1311](https://github.com/anomalyco/opentui/issues/1311) reports a separate `drawBox` border-loop gap. Diff backgrounds use verified scissor-aware `fillRect`, not `drawBox`.

## 1. Exact rendering pipeline

1. `EditTool` creates a patch with `createTwoFilesPatch`, sends `{ filepath, diff }` in permission metadata, recomputes after formatting, and returns final `diff`, `filediff`, and diagnostics ([`edit.ts:80-202`](https://github.com/anomalyco/opencode/blob/e00890c67261a435cee6409366a68999a93393fd/packages/opencode/src/tool/edit.ts#L80-L202)).
2. Session `Edit` reads `props.metadata.diff` and renders a full-width `<diff>` in `BlockTool`; before metadata arrives it shows “Preparing edit...” ([`Edit`](https://github.com/anomalyco/opencode/blob/e00890c67261a435cee6409366a68999a93393fd/packages/tui/src/routes/session/index.tsx#L2394-L2444)).
3. Messages and tools are children of one sticky-bottom conversation `<scrollbox>` ([source](https://github.com/anomalyco/opencode/blob/e00890c67261a435cee6409366a68999a93393fd/packages/tui/src/routes/session/index.tsx#L1180-L1204)); OpenTUI scrolls by negatively translating its content ([source](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/renderables/ScrollBox.ts#L340-L379)).
4. `ApplyPatch` uses the same `<diff>` for every non-deleted file ([source](https://github.com/anomalyco/opencode/blob/e00890c67261a435cee6409366a68999a93393fd/packages/tui/src/routes/session/index.tsx#L2447-L2484)); deleted files get a count summary ([source](https://github.com/anomalyco/opencode/blob/e00890c67261a435cee6409366a68999a93393fd/packages/tui/src/routes/session/index.tsx#L2494-L2520)).
5. Permission `EditBody` reads request `metadata.filepath` / `metadata.diff` and renders the same `<diff>` in its own height-100% `<scrollbox>`, with word wrap and a scrollbar ([source](https://github.com/anomalyco/opencode/blob/e00890c67261a435cee6409366a68999a93393fd/packages/tui/src/routes/session/permission.tsx#L22-L79)).

## 2. Split/unified lanes and theme styling

OpenCode maps `diff_style: "stacked"` to `"unified"`; otherwise it uses `"split"` above 120 columns and `"unified"` at narrower widths ([conversation](https://github.com/anomalyco/opencode/blob/e00890c67261a435cee6409366a68999a93393fd/packages/tui/src/routes/session/index.tsx#L2400-L2406), [permission](https://github.com/anomalyco/opencode/blob/e00890c67261a435cee6409366a68999a93393fd/packages/tui/src/routes/session/permission.tsx#L38-L42)).

It passes `diffAddedBg`, `diffRemovedBg`, `diffContextBg`, sign colors, `diffLineNumber`, and distinct added/removed line-number backgrounds ([theme contract](https://github.com/anomalyco/opencode/blob/e00890c67261a435cee6409366a68999a93393fd/packages/tui/src/theme/index.ts#L36-L66), [diff props](https://github.com/anomalyco/opencode/blob/e00890c67261a435cee6409366a68999a93393fd/packages/tui/src/routes/session/index.tsx#L2416-L2435)). These are real backgrounds; for example, Catppuccin defines separate content and gutter values ([asset](https://github.com/anomalyco/opencode/blob/e00890c67261a435cee6409366a68999a93393fd/packages/tui/src/theme/assets/catppuccin.json#L78-L84)).

### Unified

`buildUnifiedView` flattens hunks into one code stream. Added, removed, and context rows each receive corresponding gutter/content `LineColorConfig` values; it creates one 100%-wide `LineNumberRenderable` ([source](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/renderables/Diff.ts#L483-L579)).

### Split

`buildSplitView` creates a left removal stream and right addition stream, duplicates context, and inserts empty alignment rows when one side has no peer ([source](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/renderables/Diff.ts#L587-L709)). Only `remove`/`context` rows get left colors and only `add`/`context` rows get right colors; `empty` rows get no added/removed color. Both sides are 50% wide ([source](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/renderables/Diff.ts#L823-L923)). Thus OpenCode does not intentionally paint an empty colored lane for an unpaired row.

## 3. How scrolling clips backgrounds

1. `ScrollBoxRenderable` creates an `overflow: "hidden"` viewport and translated content ([source](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/renderables/ScrollBox.ts#L326-L379)).
2. Render traversal wraps every non-visible overflow boundary's children in `pushScissorRect` / `popScissorRect` ([source](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/Renderable.ts#L1413-L1460)); execution applies these to the cell buffer and hit grid ([source](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/Renderable.ts#L1818-L1825)).
3. The native buffer intersects nested scissors so children cannot widen beyond the parent viewport ([source](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/zig/buffer.zig#L345-L365)). First-party [PR #389](https://github.com/anomalyco/opentui/pull/389), merged as [`04ea4c0`](https://github.com/anomalyco/opentui/commit/04ea4c04741255b676ce9478dc998603a9ef1969), explicitly added nested ScrollBox scissor intersection to prevent bleed.
4. Diff lane `fillRect` calls reject wholly out-of-scissor rectangles, intersect partial rectangles, and fill only the clipped range ([source](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/zig/buffer.zig#L921-L953)). A translated line cannot continue filling a fixed viewport-edge row through this primitive.

Viewport culling is separate and defaults on: it skips fully invisible children, while scissors handle partial visibility ([implementation](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/renderables/ScrollBox.ts#L11-L52), [default](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/renderables/ScrollBox.ts#L277-L290)).

## 3a. Measured Wincode reproduction and root cause

**Verified:** Removing Wincode's framebuffer pass from `ChatShell` leaves the three targeted regressions with two failures: the unpaired split lane retains the added background, and summary text can retain a diff background. The genuine blank-added-line case remains green. These failures persist after one-variable composition experiments for the diff wrapper, scrollbox sizing, overflow, and viewport culling; the direct OpenTUI 0.5.6 candidate also did not remove the split-lane failure.

**Minimized cause:** At the failing boundary, `LineNumberRenderable.renderSelf` calls `buffer.fillRect` for a colored line with a negative translated `y` (for example, `y = -1`). OpenTUI's JavaScript `OptimizedBuffer.fillRect` forwarded `x` and `y` to the native FFI binding as unsigned integers. On the measured Bun/macOS runtime, `fillRect(0, -1, ...)` painted row `0` instead of rejecting or clipping the out-of-viewport row. The glyph path uses signed coordinates and clips correctly, so the background can survive without its glyph and an empty split alignment lane can inherit the preceding added row's color.

**Renderer-native correction:** The patch at [`patches/@opentui%2Fcore@0.4.5.patch`](../../patches/@opentui%2Fcore@0.4.5.patch) clips negative coordinates and adjusts width/height in `OptimizedBuffer.fillRect` before calling the unsigned native binding. It preserves partial rectangles that cross the top or left edge and rejects wholly out-of-bounds rectangles. With the application pass absent, the focused unpaired-lane and summary-background regressions pass against the patched renderer.

The executable [`scripts/opentui-diff-clipping-repro.ts`](../../scripts/opentui-diff-clipping-repro.ts) accepts `OPENTUI_CORE_SPECIFIER` so the same probe can run against extracted package builds. The unpatched `@opentui/core@0.4.5` baseline and the `0.5.6` candidate both fail with the negative-coordinate bleed; the workspace's patched renderer passes.

This is an OpenTUI coordinate-boundary defect, not a Wincode render-tree mismatch. The application remains on direct `scrollbox`/`diff` composition and keeps all theme backgrounds, gutters, signs, line numbers, wrapping, and split/unified behavior.

## 4. Post-render cleanup and patching: negative findings

**Verified absence in the pinned OpenCode tree:** `Edit`, `ApplyPatch.Diff`, the conversation scrollbox, and permission `EditBody` never receive an `OptimizedBuffer`, read raw cells, or repaint after the diff. They only compose JSX and pass layout/style props (sources above).

A pinned-tree search of `packages/tui/src` for `renderBefore`, `renderAfter`, `currentRenderBuffer`, `nextRenderBuffer`, `buffers.bg`, `clearScissorRects`, `framebuffer`, and buffer/diff-token combinations found only unrelated editor clearing and Go upsell animation code. The dependency patch directory has no OpenTUI patch ([`patches/`](https://github.com/anomalyco/opencode/tree/e00890c67261a435cee6409366a68999a93393fd/patches)).

Classification:

- **App-level workaround:** no.
- **Bespoke/different diff renderer:** no; direct OpenTUI `DiffRenderable` composition.
- **OpenCode patch to OpenTUI:** no.
- **Wincode renderer correction:** yes—a committed Bun patch clips signed JavaScript coordinates before OpenTUI's unsigned native `fillRect` binding.
- **Known renderer defect:** OpenTUI 0.4.5's JavaScript-to-native `fillRect` binding does not clip negative coordinates before passing unsigned FFI arguments; the minimized Wincode reproduction demonstrates the resulting top-row background bleed.

## 5. Direct comparison with Wincode's workaround

Wincode declares `@opentui/core: ^0.2.1` ([source](https://github.com/sonwjnn/wincode/blob/0d0677cbf2a83a87f4199fb299a69d1918a05984/apps/cli/package.json#L18-L28)); its locally installed first-party package metadata resolves to 0.2.7. OpenCode pins core/keymap/Solid to 0.4.5 ([source](https://github.com/anomalyco/opencode/blob/e00890c67261a435cee6409366a68999a93393fd/package.json#L40-L46)), confirmed by OpenTUI's package metadata ([source](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/package.json#L1-L13)).

Historical Wincode workaround (removed by issue #33) that OpenCode does not contain:

- `clearBlankDiffLanesAtViewportTop` inspects raw character/background arrays on exactly the viewport's top row, detects added/removed color groups, and replaces backgrounds with the conversation color only when a lane has no non-space cell ([source](https://github.com/sonwjnn/wincode/blob/0d0677cbf2a83a87f4199fb299a69d1918a05984/apps/cli/src/modules/conversations/ui/components/chat-shell.tsx#L24-L113)).
- `ChatShell` installs it as `renderBefore` on a final absolute one-cell box after conversation content; the adjacent comment describes clipped glyphs but lingering full-row backgrounds ([setup](https://github.com/sonwjnn/wincode/blob/0d0677cbf2a83a87f4199fb299a69d1918a05984/apps/cli/src/modules/conversations/ui/components/chat-shell.tsx#L143-L179), [hook](https://github.com/sonwjnn/wincode/blob/0d0677cbf2a83a87f4199fb299a69d1918a05984/apps/cli/src/modules/conversations/ui/components/chat-shell.tsx#L258-L266)).

**Direct answer:** OpenCode's composition has no framebuffer cleanup, but the verified Wincode reproduction exposed a separate OpenTUI `fillRect` coordinate-boundary defect: negative translated lane fills were coerced to row zero. Wincode now consumes a renderer-level patch that clips those coordinates before native submission; no application framebuffer mutation remains.

## 6. Auditable search record

Searched the pinned OpenCode tree at:

- `packages/tui/src/routes/session/index.tsx`: `Edit`, `ApplyPatch`, `<diff`, `<scrollbox`, all diff backgrounds, `renderBefore`, `renderAfter`.
- `packages/tui/src/routes/session/permission.tsx`: `EditBody`, `metadata.diff`, `<scrollbox`, `<diff`.
- `packages/tui/src/theme/index.ts` and `theme/assets/*.json`: all diff background/sign/line-number tokens.
- Whole `packages/tui/src`: `renderBefore|renderAfter|currentRenderBuffer|nextRenderBuffer|buffers.bg|clearScissorRects|framebuffer` and buffer/diff-token combinations.
- `patches/`: OpenTUI-named patches (none).
- OpenTUI 0.4.5 `Diff.ts`, `LineNumberRenderable.ts`, `ScrollBox.ts`, `Renderable.ts`, `buffer.ts`, and `zig/buffer.zig`: lane construction, `fillRect`, overflow, scissors, culling, framebuffer hooks.
- First-party issue/PR searches combining `scrollbox background diff`, `scissor clipping scroll`, `addedBg`, `removedBg`, `viewport`, and `bleed`. No diff-background-specific report was found; relevant general history is [PR #389](https://github.com/anomalyco/opentui/pull/389), with the adjacent non-diff gap in [issue #1311](https://github.com/anomalyco/opentui/issues/1311).

## 7. Answer in one sentence

OpenCode uses direct themed OpenTUI diff composition without framebuffer cleanup; Wincode's measured regressions were caused by unsigned FFI coordinates in OpenTUI `fillRect`, now corrected by the committed renderer patch while the application pass is deleted.

