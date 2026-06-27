# Control plane

The **dispatch** tool, the operator **registry**, and the **watcher**. Runs as the
**operator** user (trusted; has sudo) and drops to each repo's Linux user to run a
jailed agent.

Paths below assume the runner is cloned at `~agent/agent-runner` (`/home/agent/agent-runner`).

## Why shell, not the TS runner
The operator has no Node toolchain on the executor (only the agent users do). The
dispatch is therefore plain bash with a shell-sourceable registry — nothing for the
operator to install.

## Registry (operator config — NOT version-controlled with a product repo)
Live config lives in `~/.config/agent-runner/` on the executor (override with
`$AGENT_RUNNER_CONFIG`). Copy the templates here and edit:

```bash
mkdir -p ~/.config/agent-runner/repos
cp ~agent/agent-runner/control/defaults.conf.example ~/.config/agent-runner/defaults.conf
cp ~agent/agent-runner/control/repos/example.conf.example ~/.config/agent-runner/repos/<repo>.conf
```

`defaults.conf` sets fleet-wide values; each `repos/<name>.conf` overrides them and
must set `REPO_PATH` + `REPO_USER`. The registry holds only the **machine binding**:
`REPO_PATH`, `REPO_USER`, `PROXY`. **How to drive the agent — `assistant`, `model`,
`effort` — lives in each repo's `.agent/config.json`** (versioned with the code; a
model id is assistant-specific, so the three travel together). **Role** is
per-dispatch and defaults to `dev` (`dispatch <repo> --loop qa` to override).
**Secrets never go here** (PATs are `0600` files owned by the repo user).

## Passwordless dispatch (sudoers)
`dispatch` drops to the repo user with `sudo -iu`. Without a rule it prompts for the
operator's password once per run; the watcher needs it silent. The operator already
has root, so this grants **no new privilege** — it only removes the prompt (replace
`<operator>`/`agent` with your users):

```bash
echo '<operator> ALL=(agent) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/agent-runner-dispatch
sudo chmod 0440 /etc/sudoers.d/agent-runner-dispatch
sudo visudo -cf /etc/sudoers.d/agent-runner-dispatch     # validate before trusting it
```

(Per-repo users later → one `<operator> ALL=(agent-<repo>) NOPASSWD: ALL` line each.)

## Use
```bash
~agent/agent-runner/bin/dispatch <repo> --drain
~agent/agent-runner/bin/dispatch <repo> --task TASK-15
~agent/agent-runner/bin/dispatch <repo> --loop qa        # a qa pass instead of dev
```

`dispatch` runs **now** and is `flock`-guarded: if a run for that repo is already
active it returns 75 and does nothing (it does not wait). To run something *when the
repo is next free* without timing it yourself, queue it instead — see One-off runs.

The runner is its own clone — update it with `cd ~agent/agent-runner && git pull`
(no in-product bootstrap; `orchestrate` owns each product repo's git).

## Watcher (push and walk away)
`bin/watch` (run as the operator) polls the registry and drains each repo's board
through `dispatch` — so you just push tickets, no SSH, no manual dispatch. It's
stateless: the board is the queue, dispatch's `flock` is the per-repo mutex (a poll
while a run is active returns 75 and is skipped), and `orchestrate` early-exits when
nothing's ready (idle polls are cheap).

Install the systemd `--user` unit (as the operator on the executor):
```bash
loginctl enable-linger "$USER"        # keep it running while you're logged out (overnight!)
mkdir -p ~/.config/systemd/user
cp ~agent/agent-runner/control/systemd/agent-watch.service ~/.config/systemd/user/
# (the unit's ExecStart already points at /home/agent/agent-runner/bin/watch)
systemctl --user daemon-reload
systemctl --user enable --now agent-watch.service
```

- **Logs:** `journalctl --user -u agent-watch -f`
- **Per-run status:** each real run writes `~/.config/agent-runner/status/<repo>`
  (time, what ran, ok/failed, the outcome line) — the last outcome at a glance without
  opening a transcript, and what the TUI reads.
- **Pause:** `touch ~/.config/agent-runner/PAUSED` (all repos) or
  `~/.config/agent-runner/repos/<name>.paused` (one repo). Remove to resume.
- **Stop:** `systemctl --user stop agent-watch`
- **Cadence:** `WATCH_INTERVAL` (seconds, default 120) in the unit's `Environment=`.

With a repo in `accumulate` mode the watcher just keeps `auto/work` drained; you
merge `auto/work → base` periodically. To update the runner code:
`cd ~agent/agent-runner && git pull && systemctl --user restart agent-watch`.

## One-off runs (enqueue)
To run a role once — e.g. a steward or qa pass — without timing it against the drain
or pausing anything, **queue it** and let the watcher pick it up at the next free slot:

```bash
~agent/agent-runner/bin/enqueue <repo> --loop steward
~agent/agent-runner/bin/enqueue <repo> --loop qa
```

`enqueue` drops a job file under `~/.config/agent-runner/queue/<repo>/`. Each tick the
watcher runs that repo's **oldest** queued job **before** the periodic drain, then
removes it once it has run — a one-off runs once. `flock` still serialises everything,
so a queued run never overlaps the drain or a manual `dispatch`; if the repo is busy
when its turn comes the job stays queued and retries next tick. It's a queue, **not a
cron**: the run fires the next time the repo is free, then it's gone. Cancel a pending
job by deleting its file from the queue dir.
