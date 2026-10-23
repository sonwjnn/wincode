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

For release smoke tests, start tmux with `-c /tmp` and replace the launcher with the absolute release-binary path. Test each supported runtime separately, submit a prompt, and wait for the model reply; startup alone is not a passing smoke test. Get explicit approval before any billable Provider request.
