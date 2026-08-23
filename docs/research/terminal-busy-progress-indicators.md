# Terminal busy and progress indicators — primary-source research

| | |
|---|---|
| Research date | 2026-08-23 |
| Prime Agent revision | [`e319a66d7351c75abe7f040d02d9a8d6e25028e9`](https://github.com/PrimeIntellect-ai/prime-agent/tree/e319a66d7351c75abe7f040d02d9a8d6e25028e9) |
| Grok Build revision | [`19d42e35c07a9c9244f03f6df0c4c353f970d4f9`](https://github.com/xai-org/grok-build/tree/19d42e35c07a9c9244f03f6df0c4c353f970d4f9) |
| OpenCode revision | [`3a31c4ea801915c0b050df4b3842997ea62b6e93`](https://github.com/anomalyco/opencode/tree/3a31c4ea801915c0b050df4b3842997ea62b6e93) |
| Wincode target | [`apps/cli/src/shared/ui/progress-bar.tsx`](../../apps/cli/src/shared/ui/progress-bar.tsx) |
| Scope | Busy/progress glyphs, cadence, motion, labels, colors, width, readability, and terminal constraints |

## Executive conclusion

**Directly observed:** The three references do not converge on one universal animation. Prime Agent uses a compact one-cell Braille spinner at 80 ms per frame with an adjacent message. Grok Build supplies a determinate, caller-sized Unicode bar at eighth-cell resolution and explicitly falls back for legacy Windows consoles; its broader TUI exposes animation controls, including a 30 fps setting and an optional animated thinking accent. Current first-party OpenCode uses the pattern closest to Wincode's footer: an agent-colored, fixed eight-cell, bidirectional scanner next to a textual interrupt hint, with a static `[⋯]` fallback when animations are disabled.

**Recommendation:** Keep Wincode's fixed-width, agent-colored footer geometry and separate `Esc interrupt` text. Retain the inexpensive 80 ms discrete bounce unless Wincode deliberately adopts OpenCode's substantially richer 40 ms alpha-trail animation. Add a reduced-animation fallback, and avoid fractional-block glyphs unless a legacy-Windows substitute is also provided.

## Evidence table

| Project | Directly observed glyphs and geometry | Cadence and motion | Labels and colors | Readability / terminal constraints |
|---|---|---|---|---|
| Prime Agent | Default frames are `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`. One frame is rendered, followed by one literal space and the message. | `80 ms` per frame; index advances by one modulo the frame count. Custom frames and cadence are accepted. A zero- or one-frame indicator does not run a timer. There is no easing: motion is discrete frame substitution. | The indicator and message pass through separate color functions. Default message is `Loading...`; callers can replace it. | The primitive is compact and fixed-height. This source has no terminal-specific glyph fallback or reduced-motion branch; it does safely allow a static one-frame custom indicator. |
| Grok Build | Determinate bar uses `▏▎▍▌▋▊▉█`, quantized to eighths of a terminal cell. Width is a caller-supplied character-cell count; value is clamped to `0..1`. | The progress-bar primitive itself is not animated and defines no cadence/easing. Separately, the first-party TUI configuration defaults animation to `30` ticks per second and `32` rows per accent-wave cycle, and allows the thinking accent to be disabled. | Filled cells use caller-supplied foreground over track background; empty cells use the track background. Running foldable entries can show the `›` indicator. | Grok explicitly documents that legacy ConHost's default Consolas lacks narrow fractional blocks U+258F–U+2589, so it substitutes CP437-friendly density glyphs `░▒▓` while preserving the same eighth-resolution input. |
| OpenCode | Busy footer uses an eight-character scanner. With `style: "blocks"`, active cells are `■` and inactive cells are `⬝`. | Prompt renders at `40 ms` per frame (25 fps). Default generator cycle is 54 frames: 8 forward, hold 9 at the end, 7 backward, hold 30 at the start, for 2.16 s total. Position changes are discrete; color opacity supplies the easing-like treatment. | Scanner color comes from the agent that authored the last user message, falling back to the current agent/theme border. The call uses inactive alpha factor `0.6`, minimum fade alpha `0.3`, and a same-hue six-step trail. Busy footer also shows `esc interrupt`, changing to `esc again to interrupt` after the first escape. Retry state adds the error plus retry countdown/attempt. | When `animations_enabled` is false, the animated scanner becomes static muted `[⋯]`. The eight-cell scanner therefore has a first-party reduced-animation/readability path rather than relying on motion alone. |

## 1. Prime Agent

Prime Agent's reusable `Loader` defines ten Braille frames and an `80 ms` default interval ([source](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/tui/src/components/loader.ts#L9-L15)). It copies the configured frames, resets to frame zero, and advances with `(currentFrame + 1) % frames.length`; if there is at most one frame, it does not create an interval ([source](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/tui/src/components/loader.ts#L39-L55)). Every tick updates the displayed text and requests a TUI render ([source](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/tui/src/components/loader.ts#L56-L65)).

The renderer applies the spinner color to the default frames, inserts a single separating space, and applies an independent message color to the label. The constructor's default label is `Loading...`; both the message and the entire indicator definition are replaceable ([source](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/tui/src/components/loader.ts#L17-L31), [rendering](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/tui/src/components/loader.ts#L56-L65)).

### Interpretation boundary

These facts describe Prime Agent's first-party loader primitive. The loader source does not prescribe a fixed message color, terminal-width fallback, direction setting, or reduced-motion preference. It does allow callers to provide a static single frame, but that is capability, not evidence that Prime Agent exposes a user-facing reduced-motion setting.

## 2. Grok Build

Grok Build's first-party `progress_bar` module is determinate rather than a busy scanner. It uses left fractional blocks `▏▎▍▌▋▊▉█`, with index zero represented by an empty string ([source](https://github.com/xai-org/grok-build/blob/19d42e35c07a9c9244f03f6df0c4c353f970d4f9/crates/codegen/xai-grok-pager/src/views/progress_bar.rs#L1-L22)). It clamps progress to `0..1`, converts the requested width to total eighths, rounds, and splits that value into whole cells plus one partial cell ([source](https://github.com/xai-org/grok-build/blob/19d42e35c07a9c9244f03f6df0c4c353f970d4f9/crates/codegen/xai-grok-pager/src/views/progress_bar.rs#L34-L57)). Both the span compositor and direct buffer renderer accept caller-supplied width, filled foreground, and track background ([source](https://github.com/xai-org/grok-build/blob/19d42e35c07a9c9244f03f6df0c4c353f970d4f9/crates/codegen/xai-grok-pager/src/views/progress_bar.rs#L59-L105)).

The terminal constraint is explicit: Consolas in legacy ConHost lacks the narrow fractional blocks, so Grok swaps the glyph table to `░▒▓` density steps while retaining the same index domain and full `█` endpoint ([source](https://github.com/xai-org/grok-build/blob/19d42e35c07a9c9244f03f6df0c4c353f970d4f9/crates/codegen/xai-grok-pager/src/views/progress_bar.rs#L1-L32)). This is the strongest primary-source warning against assuming every visually attractive Unicode progress glyph renders consistently across terminal/font combinations.

Grok's documented TUI configuration separately defines `fps = 30` and `wave_rows = 32` for animation ([source](https://github.com/xai-org/grok-build/blob/19d42e35c07a9c9244f03f6df0c4c353f970d4f9/crates/codegen/xai-grok-pager/docs/user-guide/05-configuration.md#L658-L664)). Scrollback can show the running-entry expand indicator, whose default character is `›`, and thinking blocks have an `animate` switch for their accent ([source](https://github.com/xai-org/grok-build/blob/19d42e35c07a9c9244f03f6df0c4c353f970d4f9/crates/codegen/xai-grok-pager/docs/user-guide/05-configuration.md#L699-L706), [thinking setting](https://github.com/xai-org/grok-build/blob/19d42e35c07a9c9244f03f6df0c4c353f970d4f9/crates/codegen/xai-grok-pager/docs/user-guide/05-configuration.md#L728-L735)).

### Interpretation boundary

The `30 fps` and `wave_rows` settings govern Grok's general accent animation; they are not the cadence of `progress_bar.rs`, which is a static renderer driven by a numeric value. Grok therefore provides useful evidence for terminal-safe glyph selection, determinate precision, color/track separation, and configurable animation, but not a directly reusable indeterminate-footer frame sequence.

## 3. OpenCode and the `opencode2` ambiguity

### Exact source selected

The literal name `opencode2` is ambiguous. A repository with that exact name, [`dzikipunk/opencode2`](https://github.com/dzikipunk/opencode2/tree/e6e072dd5476853d419a1d9751c0d7ecb6512f3d), is archived; its pinned README says the project moved to Charm's Crush and is no longer maintained ([source](https://github.com/dzikipunk/opencode2/blob/e6e072dd5476853d419a1d9751c0d7ecb6512f3d/README.md#L1-L12)). It is not the actively maintained OpenCode repository linked from `opencode.ai`.

For a current first-party comparison, this note examines the official [`anomalyco/opencode`](https://github.com/anomalyco/opencode/tree/3a31c4ea801915c0b050df4b3842997ea62b6e93) source. This choice is explicit rather than an assertion that `opencode2` is an alias. If the request intended a private artifact, historical branch, screenshot, or a different repository named `opencode2`, its identity was not provided and cannot be established from the name alone.

### Footer scanner

OpenCode's prompt chooses the agent that authored the last user message while busy, falls back to the current agent, and derives a scanner from that agent's color. It calls `createFrames`/`createColors` with `style: "blocks"`, `inactiveFactor: 0.6`, and `minAlpha: 0.3` ([source](https://github.com/anomalyco/opencode/blob/3a31c4ea801915c0b050df4b3842997ea62b6e93/packages/tui/src/component/prompt/index.tsx#L1329-L1349)).

`createFrames` defaults to width eight. In block mode, each cell is `■` when active and `⬝` when inactive. Its bidirectional cycle is eight forward frames, a nine-frame end hold, seven backward frames, and a thirty-frame start hold: 54 frames total ([source](https://github.com/anomalyco/opencode/blob/3a31c4ea801915c0b050df4b3842997ea62b6e93/packages/tui/src/ui/spinner.ts#L283-L337)). The scanner-state function defines the forward, endpoint hold, backward, and start-hold phases explicitly ([source](https://github.com/anomalyco/opencode/blob/3a31c4ea801915c0b050df4b3842997ea62b6e93/packages/tui/src/ui/spinner.ts#L24-L94)).

The footer renders those frames at `40 ms` per frame. If animations are disabled, it renders muted `[⋯]` instead. Beside it, textual state remains available as `esc interrupt` or `esc again to interrupt`; retry state adds a human-readable error and retry countdown/attempt ([source](https://github.com/anomalyco/opencode/blob/3a31c4ea801915c0b050df4b3842997ea62b6e93/packages/tui/src/component/prompt/index.tsx#L1521-L1599)).

OpenCode's color trail is not a positional interpolation. Positions still move cell by cell, while color supplies a fade: a six-step same-hue trail uses full alpha at the lead, `0.9` alpha plus a `1.15` brightness bloom for the next step, then exponential alpha decay by `0.65^(i-1)` ([source](https://github.com/anomalyco/opencode/blob/3a31c4ea801915c0b050df4b3842997ea62b6e93/packages/tui/src/ui/spinner.ts#L153-L199)). The inactive color retains the hue with reduced alpha, and global fade progresses linearly during movement/holds down to the configured minimum ([source](https://github.com/anomalyco/opencode/blob/3a31c4ea801915c0b050df4b3842997ea62b6e93/packages/tui/src/ui/spinner.ts#L105-L151), [inactive derivation](https://github.com/anomalyco/opencode/blob/3a31c4ea801915c0b050df4b3842997ea62b6e93/packages/tui/src/ui/spinner.ts#L201-L214)).

OpenCode also has a compact reusable spinner using the same ten Braille frames as Prime Agent at `80 ms`, with `⋯` plus child text when animations are disabled ([source](https://github.com/anomalyco/opencode/blob/3a31c4ea801915c0b050df4b3842997ea62b6e93/packages/tui/src/component/spinner.tsx#L9-L18)). That distinction matters: OpenCode reserves the richer 25 fps eight-cell scanner for the main busy footer and uses the cheaper one-cell spinner for local operations.

## 4. Wincode implementation — directly observed

Wincode's revised component uses a fixed width of twelve and an `80 ms` interval, moving a six-cell square trail across the bar and back with endpoint fade holds ([source](../../apps/cli/src/shared/ui/progress-bar.tsx)). Agent-colored `■` cells use OpenCode's six-step treatment—full-opacity head, a `0.9` alpha/`1.15` brightness bloom, then `0.65`, `0.42`, `0.27`, and `0.18` alpha—over a muted `⬝` track. The 35-frame cycle preserves Prime Agent's economical cadence while reproducing OpenCode's alpha/color-trail principle.

The chat footer renders the progress component only while busy and follows it with an agent-colored `Esc` plus a muted interrupt hint ([source](../../apps/cli/src/modules/conversations/ui/components/chat-shell.tsx#L156-L166)). This textual hint preserves meaning independently of color or motion.

## 5. Design recommendations for `progress-bar.tsx`

The following are recommendations, not claims about upstream behavior.

1. **Keep a fixed footprint, agent hue, and muted track.** This is the closest shared pattern with OpenCode's main footer and gives stable layout. Wincode uses the same `■` active and `⬝` inactive square glyphs in a wider twelve-cell treatment, with a six-step same-hue alpha trail.
2. **Retain the current 80 ms discrete bounce unless adopting OpenCode's whole color system.** Prime Agent and OpenCode's compact spinner both establish 80 ms as a readable, economical cadence. Copying OpenCode's 40 ms timer without its alpha trail and endpoint holds would increase rerenders without reproducing the observed effect.
3. **Provide a non-animated fallback.** Follow OpenCode's first-party precedent: when animation is disabled, render a stable busy token such as muted `[⋯]` or a static twelve-cell state. Motion should not be the only evidence that the agent is busy.
4. **Keep the adjacent `Esc interrupt` text separate from the animation.** It is more readable than embedding status in glyph shape or color, and it communicates the available action even when animation is disabled or frames render poorly.
5. **Do not switch to fractional Unicode blocks without a tested fallback.** If future work adopts `▏▎▍▌▋▊▉█`, also adopt host/font detection or a safe density/ASCII substitute comparable to Grok's legacy-ConHost path. Fixed-width, single-cell glyphs are a terminal UI contract, not merely decoration.

## 6. Limitations

- Research used official repository source, first-party documentation, and pinned repository metadata. It did not infer timing from videos or third-party screenshots.
- Prime Agent's evidence is its reusable loader primitive; downstream callers may choose other messages or colors.
- Grok Build's progress bar is determinate. Its documented 30 fps wave is a separate animation system and must not be presented as the bar's cadence.
- `opencode2` was not uniquely identified. The exact-name public repository is archived and redirects readers to Crush; the active official OpenCode source was selected and named explicitly rather than guessed to be identical.
- Color appearance depends on theme, terminal palette/compositing, and font. Source establishes the color relationships—agent hue, inactive alpha/muted track, foreground/background—not universal RGB values.

## Primary-source URL index

- Prime Agent loader: https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/tui/src/components/loader.ts#L9-L65
- Grok Build progress bar: https://github.com/xai-org/grok-build/blob/19d42e35c07a9c9244f03f6df0c4c353f970d4f9/crates/codegen/xai-grok-pager/src/views/progress_bar.rs#L1-L105
- Grok Build animation/configuration: https://github.com/xai-org/grok-build/blob/19d42e35c07a9c9244f03f6df0c4c353f970d4f9/crates/codegen/xai-grok-pager/docs/user-guide/05-configuration.md#L658-L735
- OpenCode prompt footer: https://github.com/anomalyco/opencode/blob/3a31c4ea801915c0b050df4b3842997ea62b6e93/packages/tui/src/component/prompt/index.tsx#L1329-L1349 and https://github.com/anomalyco/opencode/blob/3a31c4ea801915c0b050df4b3842997ea62b6e93/packages/tui/src/component/prompt/index.tsx#L1521-L1599
- OpenCode scanner implementation: https://github.com/anomalyco/opencode/blob/3a31c4ea801915c0b050df4b3842997ea62b6e93/packages/tui/src/ui/spinner.ts#L24-L214 and https://github.com/anomalyco/opencode/blob/3a31c4ea801915c0b050df4b3842997ea62b6e93/packages/tui/src/ui/spinner.ts#L283-L337
- OpenCode compact/reduced-animation spinner: https://github.com/anomalyco/opencode/blob/3a31c4ea801915c0b050df4b3842997ea62b6e93/packages/tui/src/component/spinner.tsx#L9-L18
- Exact-name archived `opencode2` limitation: https://github.com/dzikipunk/opencode2/blob/e6e072dd5476853d419a1d9751c0d7ecb6512f3d/README.md#L1-L12