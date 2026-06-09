# Chat Modules

This directory contains the CLI chat UI Modules.

## Structure

- `chat-shell.tsx` renders the full chat surface: message list, error row, input, and status hints.
- `chat-message.tsx` routes each `CodingAgentUIMessage` to the correct message renderer.
- `chat-text-area.tsx` is the OpenTUI Adapter for chat input. It owns textarea refs, keyboard forwarding, overlay rendering, and visual layout.
- `input-controller/` contains the Chat Input Controller Module. Its Interface is `state/actions`; its Implementation owns input behavior such as trigger detection, submit arbitration, overlay state, and command selection.
- `messages/` contains message renderer Modules for user, assistant, tool, reasoning, and error display.

## Architecture

The main Seam is between `chat-text-area.tsx` and `input-controller/`.

`chat-text-area.tsx` should stay thin. It may read OpenTUI state, call controller actions, render overlays, and sync text into the textarea. It should not contain input behavior such as command trigger parsing, submit rules, or overlay selection policy.

`input-controller/` should stay rendering-agnostic. It should not import OpenTUI renderables, theme hooks, or layout components. This keeps the Interface small and gives the Module Depth: callers get command-input behavior through `state/actions`, while the Implementation keeps behavior Locality.

## Extension Notes

Future file mentions should extend `input-controller/triggers.ts` and `input-controller/types.ts`, then add a mention overlay Adapter in `chat-text-area.tsx`. Avoid adding mention-specific behavior directly to `chat-text-area.tsx`.
