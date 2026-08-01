# OpenCode Theme Parity

## Goal

Replace CLI's local theme catalog with OpenCode's current built-in themes while retaining Wincode-only terminal color roles and accessibility behavior.

## Scope

- Edit `apps/cli/src/shared/providers/theme/themes.ts`.
- Replace the local catalog with OpenCode's built-in theme definitions.
- Use exact upstream dark-scheme values from `anomalyco/opencode` theme assets.
- Pin palette input to OpenCode commit `19231fce4b70aa5f7894a0a0eb20ff29bd417db5`.
- Use upstream theme slugs as local names.
- Set `opencode` as default theme.
- Update theme tests for catalog, mappings, default, and contrast behavior.

## Out of Scope

- Light-theme support.
- Runtime import or parsing of OpenCode JSON assets.
- OpenCode diff, markdown, and syntax color groups.
- Changes outside CLI theme definitions, color utilities, and their tests.

## Color Mapping

| Local role | Upstream role |
| --- | --- |
| `primary` | `primary` |
| `planMode`, `thinking` | `accent` |
| `selection` | `primary` |
| `success`, `error`, `info` | same field |
| `text`, `textMuted` | same field |
| `background`, `backgroundPanel`, `backgroundElement` | same field |
| `backgroundMenu` | `backgroundElement` (upstream assets omit menu) |
| `border`, `borderActive`, `borderSubtle` | same field |

Local `textDisabled`, file badge, and file-path roles stay derived by `resolveTheme`.

## Alpha and Transparency

Catalog values remain exact, including 8-digit hexadecimal alpha and `transparent`. Color parsing and derivation support 3/4-digit shorthand (`#RGB`/`#RGBA`) and 6/8-digit hexadecimal values, preserve supplied alpha, and return invalid color input unchanged rather than producing invalid hexadecimal output. Theme completeness tests accept 3-, 4-, 6-, and 8-digit hexadecimal colors plus `transparent`.

For `lucent-orng`, whose upstream surfaces are transparent, the local file-badge foreground derives from a WCAG black-or-white contrast choice against its primary badge background; it must never become `transparent`. Contrast calculations composite alpha colors against black unless a caller supplies a backdrop.

## Accessibility

`selection` is local selected-row background, unlike OpenCode's `selectedListItemText` foreground. It maps to upstream `primary`, matching OpenCode selected-row background behavior. Existing WCAG contrast selection for row foreground remains unchanged and must maintain at least 4.5:1 against every built-in selection color.

## Failure Handling

Themes remain static TypeScript constants. No runtime network or asset parsing failure mode is introduced. The existing missing-default error remains, now targeting `opencode`.

## Verification

1. Focused theme unit tests and color-contrast tests pass.
2. `bun run --cwd apps/cli check-types` passes.
3. `bun run check` passes.
