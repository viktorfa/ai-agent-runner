# Plan — parallel watchers across repos (Approach B: per-repo systemd template unit)

**Goal:** run repos **in parallel** (one stuck/long drain no longer blocks the others),
while keeping each repo **strictly sequential** with itself. Status today:

- **Within-repo sequential** is already guaranteed by `dispatch`'s per-repo `flock`
  (`locks/<repo>.lock`) — two runs on one repo can't overlap. *Keep this untouched.*
- **Across-repo** is serialized only by the single-threaded `bin/watch` loop, which
  runs each repo's `--drain` to completion before the next. That loop is the only
  thing to change.

**Approach B:** replace the one all-repos watcher with **one watcher process per repo**,
managed by a systemd **template unit** `agent-watch@<repo>.service`. Separate processes
= natural parallelism; separate journals = clean per-repo activity feeds; per-repo
start/stop/restart. Concurrency = "which instances you enable."

Current deployment (t14s): `~/.config/systemd/user/agent-watch.service` (viktor user
unit, `Restart=always`, `WATCH_INTERVAL=120`, linger on), `ExecStart=/home/agent/
agent-runner/bin/watch`. Registry: `floorplanner.conf`, `teksta.conf`.

---

## Change set

### 1. `bin/watch` — accept an optional repo argument

Refactor the per-repo loop body into a function and drive it by an optional arg.
**No behaviour change for a repo** — same queue-then-drain logic, same `flock`, same
status writing. Only *which* repos one process iterates changes.

- Extract the current per-repo block (pause check → queue job → else `--drain`) into
  `tick_repo() { local repo="$1"; … }` (make `job`/`jobargs`/`rc` local).
- Main loop:
  ```bash
  repo_arg="${1:-}"
  while true; do
    if [ -f "$CONFIG_DIR/PAUSED" ]; then sleep "$INTERVAL"; continue; fi
    if [ -n "$repo_arg" ]; then
      tick_repo "$repo_arg"                 # one repo (template-unit mode)
    else
      shopt -s nullglob
      for conf in "$CONFIG_DIR"/repos/*.conf; do
        tick_repo "$(basename "$conf" .conf)"
      done                                  # all repos (legacy/fallback mode)
    fi
    sleep "$INTERVAL"
  done
  ```
- `tick_repo` validates `repos/<repo>.conf` exists (so `agent-watch@typo` fails loudly
  in its own journal) and keeps the per-repo `.paused` check.
- Keep `run_repo`, `write_status`, `log` as-is. The no-arg path preserves the old
  behaviour, so nothing breaks if the template isn't used.

### 2. New template unit `control/systemd/agent-watch@.service`

```ini
[Unit]
Description=agent-runner watcher (%i)
After=network-online.target

[Service]
Type=simple
ExecStart=/home/agent/agent-runner/bin/watch %i
Environment=WATCH_INTERVAL=120
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

`%i` is the instance name = the repo (e.g. `agent-watch@floorplanner`). Runs as the
operator (viktor user unit), same as today. Keep the old `agent-watch.service` in the
repo as the legacy/single-box fallback, but it is **disabled** once migrated (running
both double-drives every repo).

### 3. TUI — make watcher status & activity per-repo

The template gives one unit + one journal per repo; point the TUI at them. This also
**eliminates the activity-feed interleaving** (the main reason for B).

- `state.go`:
  - `watcherActive()` → **per repo**: `systemctl --user is-active agent-watch@<repo>`.
    Add `watcherOn bool` to `repoStatus`; drop the single `fleet.watcherActive` (or
    keep a derived "N/M on" for the header).
  - `activityFeed(maxLines)` → `activityFeed(repo, maxLines)` reading
    `journalctl --user -u agent-watch@<repo> …` (same whitelist filter). The activity
    panel now shows the **selected** repo's clean feed.
- `main.go`:
  - Header: replace the global `watcher: active/inactive` with `watchers: N/M active`
    (or drop it — per-repo status moves into the list/detail).
  - List/detail: show a `⚠ watcher off` tag (warn style) when a repo's unit isn't
    running; otherwise nothing (on is the norm).
  - Refresh the activity feed for the selected repo on tick / cursor move.
- Tests: update `watcherActive`/`activityFeed` call sites; the existing state tests
  don't depend on systemd, so they stay green.

### 4. Docs

- `control/README.md` watcher section: install the **template** unit; enable one per
  repo; per-repo journals (`journalctl --user -u agent-watch@<repo>`); note that
  enabling/stopping a unit is how you add/remove or pause a repo from the fleet.
- `bin/watch` header comment: document the optional repo arg + the two modes.
- `tui/README.md`: activity feed is now the selected repo's journal; watcher status is
  per repo.

---

## Migration (on t14s, as viktor) — after the code is pushed & pulled

```bash
# 1. deploy
sudo -iu agent git -C ~agent/agent-runner pull

# 2. stop the single all-repos watcher
systemctl --user disable --now agent-watch.service

# 3. install the template unit
cp ~agent/agent-runner/control/systemd/agent-watch@.service ~/.config/systemd/user/
systemctl --user daemon-reload

# 4. enable one instance per repo
systemctl --user enable --now agent-watch@floorplanner.service agent-watch@teksta.service

# 5. verify
systemctl --user list-units 'agent-watch@*'                 # both active (running)
journalctl --user -u agent-watch@teksta -n 20 --no-pager    # per-repo journal
```

Adding a repo later: drop its `repos/<name>.conf`, then
`systemctl --user enable --now agent-watch@<name>.service`. Removing/pausing a repo:
`systemctl --user disable --now agent-watch@<name>.service` (or the existing
`touch repos/<name>.paused`, which the per-repo loop still honours).

### Rollback
`systemctl --user disable --now 'agent-watch@*'` then
`systemctl --user enable --now agent-watch.service`. The single unit + no-arg
`bin/watch` are unchanged, so rollback is immediate.

---

## Risks & notes

- **Resource cap.** Not a concern at the current workload (16 cores / 14 GB, 2 repos).
  It becomes one only with heavier repos (many Docker services, big builds). When it
  does: cap by enabling fewer instances, or add `MemoryMax=`/`CPUQuota=` to the
  template, or a systemd slice grouping the instances. No cap needed now.
- **Auto-discovery traded for explicit enable.** The single watcher auto-served every
  conf; the template needs one `enable` per repo. That's also the concurrency knob, so
  it's a feature, not just a cost. (A future `path`/timer-based supervisor could
  re-add auto-enable if the fleet grows; out of scope here.)
- **Interleaving: solved.** Each instance writes its own journal, so the activity feed
  is clean per repo — the core payoff of B over backgrounding one loop.
- **Locking unchanged.** Per-repo `flock` still enforces within-repo sequential, and
  still makes a stray concurrent dispatch (manual or overlapping) 75-skip. No new race.
- **Pause mechanism unchanged.** Global `PAUSED` and per-repo `.paused` still work
  (each instance checks both), so the TUI's `p` action needs no change.
- **Shared `agent` user.** Concurrent drains share the pnpm store (lock-safe) and
  corepack cache (a rare race only if two repos fetch *different* uncached pnpm
  versions at the same instant). Cleanly resolved by the deferred **per-repo Linux
  user** split — B + per-user is the natural "fully isolate each repo" endpoint.

## Acceptance criteria

- [ ] `bin/watch <repo>` loops only that repo; `bin/watch` (no arg) still loops all
      (verify with `bash -n` + a dry run against a temp `AGENT_RUNNER_CONFIG`).
- [ ] `agent-watch@floorplanner` and `agent-watch@teksta` both `active (running)`; the
      old `agent-watch.service` is `disabled`/inactive.
- [ ] A long drain in one repo no longer delays the other (observe overlapping
      `dispatch:` lines across the two per-repo journals).
- [ ] TUI shows per-repo watcher status and the selected repo's (un-interleaved)
      activity feed; tests/lint/build green.
- [ ] Rollback verified once (disable instances, re-enable the single unit).

## Suggested sequencing

1. `bin/watch` refactor + template unit + docs (one commit) — verified locally.
2. TUI per-repo watcher/feed (one commit) — verified locally.
3. Migrate t14s per the steps above.
4. (Later, optional) pair with per-repo Linux users for full isolation.
