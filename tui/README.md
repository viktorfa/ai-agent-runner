# agent-runner TUI

An operator dashboard for the runner — see every repo's status (running drain,
queued one-offs, paused, watcher state) and fire the common actions, in one screen.

It is a **pure frontend**: it reads the runner's existing operator files
(`~/.config/agent-runner/{repos,queue}`, the `.paused` flags), `ps`, and
`systemctl --user`, and acts only by writing those same files the same way the
control plane does (drop a queue file = `bin/enqueue`; touch/remove the pause flag;
remove the queue dir). It changes **nothing** about the runner's functionality,
state, or storage format — remove the TUI and the runner is unaffected.

Separate Go module (Bubble Tea v2) so it stays isolated from the TS core and the
bash control plane.

## Build

Needs Go (see `control/README.md`). Build the binary into `bin/` so it sits next to
`enqueue`/`dispatch` (the TUI resolves those as siblings):

```bash
go -C ~agent/agent-runner/tui build -o ~agent/agent-runner/bin/tui
```

## Run

```bash
~agent/agent-runner/bin/tui
```

Honours `$AGENT_RUNNER_CONFIG` (defaults to `~/.config/agent-runner`), same as the
rest of the control plane.

## Keys

| key | action |
|-----|--------|
| `↑`/`↓` (`k`/`j`) | move between repos |
| `e` | enqueue a one-off `steward` run (same queue file as `bin/enqueue <repo> --loop steward`) |
| `p` | toggle the repo's watcher pause flag |
| `x` | clear the repo's pending one-off queue |
| `r` | refresh now (also auto-refreshes every 3s) |
| `q` / `ctrl+c` | quit |
