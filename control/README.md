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
must set `REPO_PATH` + `REPO_USER`. **Secrets never go here** (PATs are `0600` files
owned by the repo user).

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
