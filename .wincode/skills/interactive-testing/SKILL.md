---
name: interactive-testing
description: Test and debug Wincode's interactive mode in a controlled tmux terminal. Use for TUI behavior checks and interactive release smoke tests.
---

# Testing Wincode Interactive Mode with tmux

Run the TUI in a controlled terminal (from the repo root):

```bash
SESSION="wincode-test-$$"
tmux new-session -d -s "$SESSION" -x 80 -y 24 -c "$PWD"
tmux send-keys -t "$SESSION" "./scripts/test-support/interactive-smoke-launcher.sh" Enter
sleep 3 && tmux capture-pane -t "$SESSION" -p
tmux send-keys -t "$SESSION" "terminal smoke stream" Enter
sleep 2 && tmux capture-pane -t "$SESSION" -p
tmux send-keys -t "$SESSION" "terminal smoke cancel" Enter
sleep 0.5 && tmux capture-pane -t "$SESSION" -p
tmux send-keys -t "$SESSION" Escape
tmux send-keys -t "$SESSION" Escape  # send twice within 3s to cancel
tmux send-keys -t "$SESSION" C-c
tmux send-keys -t "$SESSION" "/exit" Enter
sleep 1 && tmux capture-pane -t "$SESSION" -p
tmux kill-session -t "$SESSION"
```

The launcher uses a local fake Provider; no external model request is sent. If the Session Writer OS lock cannot be established, report **not verified**; do not stop another process.

## Live Provider / release smoke (may incur costs)

The faux smoke above is deterministic and does not contact a Provider. To test a
real built-in Provider, explicitly approve the billable request and name the
Provider/model:

```bash
bun run test:tui --live --approve-billable --model 'openai/<model-id>'
```

To run an existing executable instead of the source CLI, add its absolute path:

```bash
bun run test:tui --live --approve-billable \
  --model 'openai/<model-id>' --binary /absolute/path/to/wincode
```

Use built-in Provider credentials already configured in Wincode. The smoke reads only the selected
Provider credential, copies it into the temporary isolated auth store, and does
not write credential data to the normal auth store or pass Provider API-key
environment variables to the TUI. The temp home is removed on exit. Both `--live` and
`--approve-billable` are required; never run the live command without approval.

A passing live smoke must submit the prompt, receive `smoke-live-ok`, and exit
cleanly. Startup alone is not a pass. The smoke cannot guarantee token usage or
cost, and does not verify cancellation or tool calls. Run it against the actual
release executable for the current host; a source run is not binary release
proof. CI checks CLI entrypoints on all five targets and TUI startup/exit on
Linux and macOS. Headless tmux does not verify native Windows ConPTY.
