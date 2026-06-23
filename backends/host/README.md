# Host backend — t14s provisioning runbook

Docker-free isolation for the agent runner: a dedicated **`agent`** user, a
**Squid** allowlist forward proxy (no TLS interception), and an **nftables**
egress drop that confines the agent uid to the proxy. Design + rationale:
`docs/AGENT_DEV_SYSTEM.md` §6/§7. Layout on the box: §9 "Server layout".

These files are the source of truth; `provision.sh` / `lockdown.sh` install them
to `/etc`. The agent user gets **its own fnm** (not system Node).

> **Order matters:** do all toolchain/clone/install steps while the agent still
> has open egress, then run `lockdown.sh` last to close the door.

---

## Step 0 — [you] get these files onto t14s

The whole repo carries them. Clone happens in Step 4, but `provision.sh` needs
them first, so for the very first run copy this dir over (or clone once as your
user), e.g.:

```
rsync -a agent-runner/backends/host/ t14s:/tmp/agent-host/
```

## Step 1 — [root] base: agent user + Squid

```
sudo AGENT_USER=agent bash /tmp/agent-host/provision.sh
```

Creates `agent`, installs + starts Squid on `127.0.0.1:3128` with the allowlist.
The egress lockdown is **not** applied yet.

## Step 2 — [agent] toolchain: fnm + Node 24 + pnpm + claude

```
sudo -iu agent
# --- now in the agent login shell (open egress) ---
curl -fsSL https://fnm.vercel.app/install | bash      # installs fnm + shell hooks
exec bash -l                                          # reload so fnm is active
fnm install 24 && fnm default 24
corepack enable                                       # provides pnpm
curl -fsSL https://claude.ai/install.sh | bash        # claude into ~/.local/bin
claude login                                          # device flow — needs you
```

## Step 3 — [you] restricted GitHub credential

Create a **fine-grained PAT** scoped to `viktorfa/plantegner` only, **Contents:
Read/Write**, nothing else; add **branch protection on `master`** (require PR) so
the runner can only push `auto/work`. Keep the PAT for Step 4.

## Step 4 — [agent] clone + deps + browsers

```
# still as agent, open egress:
mkdir -p ~/repos && cd ~/repos
git clone https://github.com/viktorfa/plantegner.git
cd plantegner
git config credential.helper store      # stores the PAT in ~/.git-credentials (0600)
# first push/pull will prompt for username + PAT, then it's remembered
pnpm install
pnpm exec playwright install chromium    # browser binaries into agent's cache
```

If `playwright install` needs system libraries, run once as root:
`sudo bash -lc 'cd ~agent/repos/plantegner && pnpm exec playwright install-deps chromium'`

## Step 5 — [root] close egress (lockdown)

```
sudo AGENT_USER=agent bash /tmp/agent-host/lockdown.sh
```

Applies the nftables allowlist and prints verification commands (example.com must
fail; api.github.com via the proxy must work). Run them.

## Step 6 — [you/agent] smoke test one iteration

Mark a task ready on the board if needed (`cd ~/repos/plantegner && pnpm exec
backlog task list --plain`), then run the host backend for a single iteration:

```
sudo -iu agent
cd ~/repos/plantegner
./agent-runner/bin/run-agent-loop.sh \
  --assistant claude --loop dev --backend host \
  --proxy http://127.0.0.1:3128 --iterations 1
```

Watch it claim a task, implement, run gates, commit, and push `auto/work`. Back on
your machine: `git fetch origin auto/work && git log --oneline origin/auto/work -5`.

---

## Notes
- **Egress audit:** `sudo tail -f /var/log/squid/access.log` — denied hits to odd
  hosts are the prompt-injection / supply-chain signal.
- **Updating the allowlist:** edit `allowed-domains.txt` here, re-run `provision.sh`
  (or copy to `/etc/squid/` + `sudo systemctl reload squid`).
- **Tightening later:** per-repo unix users + per-uid nft rules (§9 "stronger");
  TLS-terminating MITM proxy for Class B (§6).
- The runner reaches the assistant via the agent's **login shell** (so fnm/Node and
  `claude` are on PATH) — always invoke via `sudo -iu agent` or `su - agent`.
