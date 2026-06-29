# agent-runner TUI

An operator dashboard for the runner — see every repo's status (running drain,
queued one-offs, paused, watcher state) and fire the common actions, in one screen.

Layout: the repo **list** and the selected repo's **detail** sit side by side, with a
filtered **activity** feed below — the *selected* repo's watcher journal heartbeat —
and a compact **heatmap** of commits-per-hour over the last 48h pinned at the bottom;
it falls back to a stacked layout on narrow terminals. Watcher status is **per repo**
(each repo has its own `agent-watch@<repo>` unit), shown in the header count and as a
`⚠ watcher off` tag; it also recognises the legacy single watcher during migration. For
a repo running parallel agents (`docs/PARALLEL_AGENTS.md`), the detail panel also shows
the **staging** line — how far the work branch is ahead of / behind base (what's waiting
to promote) — and a **build** line listing any in-flight per-task worktrees.

It is a **pure frontend**: it reads the runner's existing operator files
(`~/.config/agent-runner/{repos,queue,status}`, the `.paused` flags), `ps`,
`systemctl --user is-active`, and the watcher journals (`journalctl --user`, which is
also where the transcript viewer reads from) — no sudo. Only the commit heatmap, the
staging snapshot (`git rev-list` / `git worktree list`), and the role picker read the
agent-owned workspace (`git log` / `.agent/config.json`), via the existing passwordless
`sudo -u <repo-user>` path, read-only. It acts only by writing those same
operator files the way the control plane does (drop a queue file = `bin/enqueue`;
touch/remove the pause flag; remove the queue dir), plus turning a repo's own
`agent-watch@<repo>` watcher on/off through the operator's systemd **user** session
(`systemctl --user enable/disable --now`, no sudo). It changes **nothing** about the
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
| `enter` / `t` | open the selected repo's **transcript** — timestamped & readable (codex JSON rendered to `$ cmd ✓` / `💬 message` lines), follows the tail; `esc`/`q` to go back |
| `a` | full **activity** view — the heatmap (also shown at the bottom of the main view) plus a recent `auto/work` commit timeline; `r` refresh, `esc`/`q` back |
| `e` | enqueue a one-off run — pick the role (`↑/↓`, from those the repo defines in `.agent/config.json`) and iteration count (`←/→`, default 1); `enter` queues, `esc` cancels. Writes the same queue file as `bin/enqueue` |
| `p` | toggle the repo's watcher **pause** flag (watcher stays running, holds off dispatching) |
| `w` | turn the repo's **watcher** unit on/off (`systemctl --user enable/disable --now agent-watch@<repo>`) |
| `x` | clear the repo's pending one-off queue |
| `r` | refresh now (also auto-refreshes every 3s) |
| `q` / `ctrl+c` | quit |
