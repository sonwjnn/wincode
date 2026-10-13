---
status: accepted
---

# Use One Renderer Across Interactive Startup

Interactive Mode creates one OpenTUI renderer after CLI mode selection and keeps it for the full startup-to-exit lifecycle. The startup Project-trust prompt and Wincode App replace content in the same React root; trust is still resolved before protected project resources are loaded. Startup trust and Plugin diagnostics are shown in the TUI after the App mounts rather than written to `stderr` while the renderer owns the terminal. This prevents the shell repaint between preflight and app startup and gives terminal ownership and crash teardown one owner; the trade-off is keeping the renderer active while runtime initialization completes, including when a trust prompt is not needed.
