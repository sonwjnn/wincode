# Command Menu Modules

This directory contains the command menu Modules used by the chat input.

## Structure

- `commands.ts` defines the command registry and command data types.
- `filter-commands.ts` filters commands by query text.
- `index.tsx` renders the command overlay list.
- `execute-command.ts` contains the command execution Interface over command Adapters.
- `use-command-executor.tsx` wires app runtime dependencies into command Adapters.
- `adapters/` contains concrete Adapters for each command effect, such as navigation, dialogs, mode selection, model selection, toast messages, and application exit.

## Architecture

The command menu separates command description, rendering, and execution.

`commands.ts` is data-only. `index.tsx` is render-only. `execute-command.ts` is the command execution Seam: it dispatches a `CommandSpec` to a concrete Adapter without making UI Modules know about router, dialog, renderer, or prompt configuration details.

`use-command-executor.tsx` is the OpenTUI/React Adapter that binds real app dependencies to the execution Interface. Keep those runtime dependencies there instead of importing them into `execute-command.ts`.

## Extension Notes

To add a command, update `commands.ts`, add or reuse an Adapter, then update `execute-command.ts` only if the command introduces a new command kind. Keep command filtering and overlay rendering generic so the chat input controller can keep using this directory through a small Interface.
