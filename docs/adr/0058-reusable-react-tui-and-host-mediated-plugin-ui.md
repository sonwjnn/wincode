# Reuse OpenTUI and React through a host-mediated Plugin UI boundary

Status: accepted

Implementation: not implemented by this decision. The design contract is in [Reusable TUI and Plugin UI](../plans/reusable-tui-and-plugin-ui.md).

Coding-Agent and Plugins need reusable terminal components, and independent applications need the same UI foundation without depending on Coding-Agent. Create `@wincode/tui` around the existing OpenTUI and React stack rather than implementing the imperative renderer described in the [TUI research reference](../research/tui.md). The package owns reusable UI facilities, not application composition, Session state, or Agent execution.

Coding-Agent keeps ownership of Interactive Mode's single renderer, React root, terminal lifecycle, and Plugin UI admission. Plugins contribute React components through a public host-mediated API following the UI behaviors in the [Plugin research reference](../research/plugin.md), including `ctx.ui.custom()`, rather than taking exclusive possession of the terminal or creating a second renderer. Custom UI may replace the editor, appear as an overlay, or occupy the full screen within that renderer. Independent applications construct their own UI host from the reusable package.

This revises ADR-0027 only where it assigns all reusable OpenTUI facilities to Coding-Agent and removes the `@wincode/tui` package name. The new package is a UI library, not the former application boundary: the executable, application composition, Execution Modes, Session Hosts, and mode adapters stay in Coding-Agent. Noninteractive execution remains React-free; RPC Plugin UI uses capability-negotiated protocol data rather than React components. ADR-0051's single-renderer ownership and ADR-0039's public, owner-qualified Plugin boundary remain in force.

## Trade-offs

- OpenTUI and React become deliberate dependencies of the reusable UI surface. A renderer-neutral imperative API would require another rendering model and duplicate integration work.
- Host mediation gives up unrestricted Plugin control of the terminal so focus, system keys, cancellation, and teardown have one owner. It is lifecycle coordination, not a sandbox for in-process Plugin code.
- The full UI reference requires new Plugin contracts and an RPC capability, not just moving existing shared components. Neither reference file describes the currently shipped public API.
- `@wincode/tui` depends on neither Coding-Agent nor concrete Plugins. UI-neutral Plugin and RPC contracts remain loadable without importing the React implementation. Plugin presentation must not alter tool permission, Session Writer ownership, or model-context inclusion rules.
