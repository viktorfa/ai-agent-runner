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
`bin/watch` (run as the operator) drains repo boards through `dispatch` — so you just
push tickets, no SSH, no manual dispatch. `dispatch`'s `flock` is the per-repo mutex (a
poll while a run is active returns 75 and is skipped), and `orchestrate` early-exits
when nothing's ready (idle polls are cheap). It has two modes:

- `bin/watch <repo>` — serve **one** repo. Run one process per repo (below) for
  **parallelism across repos** while the flock keeps each repo sequential with itself.
- `bin/watch` (no arg) — serve **all** registry repos from one loop, sequentially.
  Simpler, but a long drain in one repo blocks the others. Legacy / single-box.

### Recommended: one watcher per repo (template unit)
Install the `--user` **template** unit and enable one instance per repo:
```bash
loginctl enable-linger "$USER"        # keep it running while you're logged out (overnight!)
mkdir -p ~/.config/systemd/user
cp ~agent/agent-runner/control/systemd/agent-watch@.service ~/.config/systemd/user/
# (ExecStart already points at /home/agent/agent-runner/bin/watch %i)
systemctl --user daemon-reload
systemctl --user enable --now agent-watch@floorplanner.service agent-watch@teksta.service
```
Adding a repo: drop its `repos/<name>.conf`, then `systemctl --user enable --now
agent-watch@<name>.service` (enabling an instance is also how you bound concurrency —
enable only as many as the box can take).

- **Logs:** `journalctl --user -u agent-watch@<repo> -f` (per repo) or
  `journalctl --user -u 'agent-watch@*'` (all).
- **Per-run status:** each real run writes `~/.config/agent-runner/status/<repo>`
  (time, what ran, ok/failed, the outcome line) — the last outcome at a glance without
  opening a transcript, and what the TUI reads.
- **Pause:** `touch ~/.config/agent-runner/PAUSED` (all repos) or
  `~/.config/agent-runner/repos/<name>.paused` (one repo); or stop the instance:
  `systemctl --user stop agent-watch@<repo>`.
- **Cadence:** `WATCH_INTERVAL` (seconds, default 120) in the unit's `Environment=`.
- **Update the runner:** `cd ~agent/agent-runner && git pull && systemctl --user
  restart 'agent-watch@*'`.

The legacy single unit (`control/systemd/agent-watch.service`, serving all repos from
one loop) still works and is the fallback / rollback target; don't run it alongside the
per-repo instances (they'd double-drive every repo).

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

## Metrics (drain telemetry)

`control/bin/collect-metrics` (fired by `agent-metrics.timer`, every 5 min) appends one
row per **work-doing** drain to `~/.config/agent-runner/metrics/drains.csv` — the
mechanical half of the agent-metrics design (the product repos' `docs/AGENT_METRICS.md`
covers the whole two-plane picture; the other half is orchestrator-authored quality
reviews, joined on task id). It answers **speed and cost**; it deliberately says nothing
about correctness or code quality.

Idle polls are skipped. It's idempotent (per repo, only drains newer than the last row),
so re-runs and missed ticks never duplicate. **Model/effort are attributed from the
transcript when present**, so per-dispatch `--model`/`--effort` overrides are preserved;
older transcripts fall back to the merged `auto/work` commit's `.agent/config.json`.

Install (on the executor, as the operator):
```bash
cp control/systemd/agent-metrics.{service,timer} ~/.config/systemd/user/
# adjust ExecStart in agent-metrics.service if the clone isn't /home/agent/agent-runner
systemctl --user daemon-reload
systemctl --user enable --now agent-metrics.timer
```

Columns: `start,end,wall_s,repo,model,effort,merged_hash,n_tasks,tasks,staged,parked,
blocked,failures,status,turns,output_tokens,reasoning_tokens,input_uncached,cached_input,
task_models`. `task_models` is empty for a uniform drain; otherwise it contains
space-separated `TASK-ID=model/effort` entries for tasks whose resolved pair differs
from the row-level `model`/`effort`.
Reasoning tokens bill as output and are already included in `output_tokens`. Cost is
`input_uncached·IN + cached_input·CACHED + output·OUT` at the model's per-token rate.

**Do not rank models by `wall_s`** — much of it is `pnpm test`/`build` in the gates,
which is model-independent; use token/reasoning for effort and $/staged for cost.

## Model + effort, and the codex version coupling

`assistant`/`model`/`effort` live in each repo's **`.agent/config.json`** (versioned with
the code — a model id is assistant-specific, so the three travel together). A one-off run
can override them: `dispatch <repo> --model <id> --effort <level>`.

Tasks can override the drain defaults with `model:<id>` and `effort:<level>` labels.
The first non-empty label of each kind wins; empty-value labels are ignored. Resolution
is task label, then dispatch flag, then `.agent/config.json`.

**A new model can require a newer codex.** Symptom: every drain fails fast with
`400 … "The '<model>' model requires a newer version of Codex"` (and a
`Model metadata for '<model>' not found` warning). Fix — upgrade the CLI for the repo
user and re-run:
```bash
sudo -iu agent bash -lc 'pnpm add -g @openai/codex@latest && codex --version'
```
Because codex is a single global CLI shared by every repo on the box, keep it current;
a stale codex silently blocks all model bumps.
