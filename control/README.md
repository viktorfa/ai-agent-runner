# Control plane (v1)

The **dispatch** tool + the operator **registry**. Runs as `viktor` (the trusted
operator) and drops to each repo's Linux user to run a jailed agent. This is the
watcher's dispatch primitive — minus the polling daemon (added later).

## Why shell, not the TS runner
`viktor` has no Node toolchain on the executor (only the agent users do). The
dispatch is therefore plain bash with a shell-sourceable registry — nothing for
the operator to install. When the control plane graduates to its own clone with
its own runtime, the registry can move to a structured format.

## Registry (operator config — NOT version-controlled with a product repo)
Live config lives in `~/.config/agent-runner/` on the executor (override with
`$AGENT_RUNNER_CONFIG`). Copy the templates here and edit:

```bash
mkdir -p ~/.config/agent-runner/repos
cp /home/agent/repos/plantegner/agent-runner/control/defaults.conf.example \
   ~/.config/agent-runner/defaults.conf
cp /home/agent/repos/plantegner/agent-runner/control/repos/floorplanner.conf.example \
   ~/.config/agent-runner/repos/floorplanner.conf
```

`defaults.conf` sets fleet-wide values; each `repos/<name>.conf` overrides them and
must set `REPO_PATH` + `REPO_USER`. The registry holds only the **machine binding**:
`REPO_PATH`, `REPO_USER`, `BACKEND`, `BASE_BRANCH`, `PROXY`. **How to drive the agent
— `assistant`, `model`, `effort` — lives in each repo's `.agent/config.json`**
(versioned with the code; a model id is assistant-specific, so the three travel
together). **Role** is per-dispatch and defaults to `dev` (`dispatch <repo> --loop
qa` to override). **Secrets never go here** (PATs are `0600` files owned by the repo
user).

## Passwordless dispatch (sudoers)
`dispatch` drops to the repo user with `sudo -iu`. Without a rule it prompts for
viktor's password once per run; the watcher needs it silent. viktor already has
root, so this grants **no new privilege** — it only removes the prompt:

```bash
echo 'viktor ALL=(agent) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/agent-runner-dispatch
sudo chmod 0440 /etc/sudoers.d/agent-runner-dispatch
sudo visudo -cf /etc/sudoers.d/agent-runner-dispatch     # validate before trusting it
```

(Per-repo users later → one `viktor ALL=(agent-<repo>) NOPASSWD: ALL` line each.)

## Use
```bash
/home/agent/repos/plantegner/agent-runner/bin/dispatch floorplanner --drain --force
/home/agent/repos/plantegner/agent-runner/bin/dispatch floorplanner --task TASK-15
```

First time only: the agent clone must already contain `bin/dispatch` (sync it once
with `sudo -iu agent git -C /home/agent/repos/plantegner fetch && \
git -C /home/agent/repos/plantegner reset --hard origin/master`). After that the
dispatch refreshes the runner code on every run.

## Watcher (push and walk away)
The watcher (`bin/watch`) runs as viktor and polls the registry, draining each
repo's board through `dispatch` — so you just push tickets, no SSH, no manual
dispatch. It's stateless: the board is the queue, dispatch's `flock` is the
per-repo mutex (a poll while a run is active returns 75 and is skipped), and
`orchestrate` early-exits when nothing's ready (idle polls are cheap).

Install the systemd `--user` unit (as viktor on the executor):
```bash
loginctl enable-linger "$USER"        # keep it running while you're logged out (overnight!)
mkdir -p ~/.config/systemd/user
cp /home/agent/repos/plantegner/agent-runner/control/systemd/agent-watch.service \
   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-watch.service
```

- **Logs:** `journalctl --user -u agent-watch -f`
- **Pause:** `touch ~/.config/agent-runner/PAUSED` (all repos) or
  `~/.config/agent-runner/repos/<name>.paused` (one repo). Remove to resume.
- **Stop:** `systemctl --user stop agent-watch`
- **Cadence:** `WATCH_INTERVAL` (seconds, default 120) in the unit's `Environment=`.

With floorplanner in `accumulate` mode the watcher just keeps `auto/work` drained;
you merge `auto/work → master` periodically. To update the watcher/dispatch code,
`systemctl --user restart agent-watch` after the clone has the new commit (the
running loop is parsed in memory, so a reset mid-run won't disturb it).
