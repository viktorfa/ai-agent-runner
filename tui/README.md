# agent-runner TUI

An operator dashboard for the runner — see every repo's status (running drain,
queued one-offs, paused, watcher state) and fire the common actions, in one screen.

It is a **pure frontend**: it reads the runner's existing operator files
(`~/.config/agent-runner/{repos,queue}`, the `.paused` flags), `ps`, and
`systemctl --user`, plus the agent-owned loop transcripts (read-only, via the
existing passwordless `sudo -u <repo-user>` path). It acts only by writing those same
operator files the same way the control plane does (drop a queue file = `bin/enqueue`;
touch/remove the pause flag; remove the queue dir). It changes **nothing** about the
runner's functionality, state, or storage format — remove the TUI and the runner is
unaffected.

Separate Go module (Bubble Tea v2) so it stays isolated from the TS core and the
bash control plane.

## Build

Needs Go (see `control/README.md`). Build it **as the operator** — the operator has
open egress so `go` can fetch modules; the agent user is egress-locked and can't. The
binary is self-contained, so put it anywhere you can run it:

```bash
mkdir -p ~/bin && go -C /home/agent/agent-runner/tui build -buildvcs=false -o ~/bin/tui
```

`-buildvcs=false` because the build runs as a different user than owns the clone, so
Go's git VCS stamping trips on `safe.directory` — and the TUI doesn't need the stamp.

## Run

```bash
~/bin/tui
```

Honours `$AGENT_RUNNER_CONFIG` (defaults to `~/.config/agent-runner`), same as the
rest of the control plane.

## Keys

| key | action |
|-----|--------|
| `↑`/`↓` (`k`/`j`) | move between repos |
| `enter` / `t` | open the selected repo's live transcript (latest loop log, follows the tail); `esc`/`q` to go back |
| `e` | enqueue a one-off run — pick the role from those the repo defines in `.agent/config.json` (`↑/↓`, `enter`, `esc`); writes the same queue file as `bin/enqueue` |
| `p` | toggle the repo's watcher pause flag |
| `x` | clear the repo's pending one-off queue |
| `r` | refresh now (also auto-refreshes every 3s) |
| `q` / `ctrl+c` | quit |
