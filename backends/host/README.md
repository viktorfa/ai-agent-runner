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
npm i -g @playwright/cli                              # the playwright-cli we use (NOT the `playwright` pkg)
playwright-cli install --skills                       # initialize the playwright-cli workspace
# skillshare (optional): materializes the repo's skills — .agent/setup.sh runs
# `skillshare sync` each loop. Installs to ~/.local/bin (on PATH, no sudo).
INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://raw.githubusercontent.com/runkids/skillshare/main/install.sh | sh
# codex is optional / later:  npm i -g @openai/codex
```

## Step 3 — [you] restricted GitHub credential + branch protection

**Fine-grained PAT (web UI only — `gh` can't mint these).** Settings → Developer
settings → Fine-grained tokens → Generate:
- Repository access: *Only select repositories* → `plantegner`
- Permissions: **Contents: Read and write** + **Metadata: Read** (auto). Nothing else.
  ("Contents" *is* the git permission — Read = clone/fetch/pull, Read+write adds
  push; there's no separate push/pull toggle.)

**Protect `master` with a ruleset (`gh`, run from your machine where gh is authed).**
Because the runner authenticates as *you* (your PAT), this blocks direct master
pushes for everyone and routes landing through a quick self-PR; `auto/work` stays
unrestricted so the runner pushes there freely:

```bash
gh api --method POST repos/viktorfa/plantegner/rulesets --input - <<'EOF'
{ "name": "Protect master", "target": "branch", "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["refs/heads/master"], "exclude": [] } },
  "rules": [
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false, "require_last_push_approval": false,
        "required_review_thread_resolution": false } },
    { "type": "non_fast_forward" }, { "type": "deletion" } ] }
EOF
```

Keep the PAT for Step 4.

## Step 4 — [agent] git config + clone + deps + browser

```bash
# still as agent, open egress.

# Commit identity (distinguishable, so runner commits stand out — or use your own):
git config --global user.name  "plantegner agent (t14s)"
git config --global user.email "vikfand+agent@gmail.com"

# Pre-seed the PAT so headless pushes never hit a prompt (0600, agent-owned).
git config --global credential.helper store
printf 'https://viktorfa:%s@github.com\n' 'PASTE_YOUR_PAT_HERE' > ~/.git-credentials
chmod 600 ~/.git-credentials

# Clone + the branch the runner works on.
mkdir -p ~/repos && cd ~/repos
git clone https://github.com/viktorfa/plantegner.git
cd plantegner
git checkout -b auto/work

# Route the agent's git through Squid. REQUIRED for any manual git (fetch/pull/push)
# after lockdown — the interactive shell has no HTTPS_PROXY, so direct git is dropped
# by nftables. (The loop itself is fine; run_host_backend exports the proxy env.)
git config --global http.proxy  http://127.0.0.1:3128
git config --global https.proxy http://127.0.0.1:3128

# Repo deps + the chromium binary for playwright-cli.
pnpm install
playwright-cli install-browser chromium   # browser binary into agent's cache
```

Chromium's **system libraries** need apt (root), and `playwright-cli` doesn't
install them. Run once **as your sudo user (viktor)** — who has pnpm via fnm — so
the libs land system-wide for the agent's chromium:

```bash
pnpm dlx playwright install-deps chromium
```

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

Watch it claim a task, implement, run gates, and commit. The loop **pushes the
working branch (`auto/work`) to `origin` after each iteration automatically** (set
`AGENT_NO_PUSH=1` to disable). It also runs `.agent/setup.sh` first (`pnpm install`
+ `skillshare sync`), so the manual `pnpm install` in Step 4 is just to get the
preview built before the first run. Back on your machine:
`git fetch origin auto/work && git log --oneline origin/auto/work -5`.

---

## Notes
- **Loop prompts** are committed at `.agent/prompts/{dev-loop,qa-loop}.md` (one
  tool-neutral source, read directly by the runner) — they work on a fresh clone, no
  sync needed.
- **Repo skills** are a skillshare-synced *output*: source in `.skillshare/skills/`,
  gitignored at `.claude/skills/`. Once skillshare is installed (Step 2),
  `.agent/setup.sh` runs `skillshare sync` each loop, so the skills materialize
  automatically. `skillshare sync` is local-only (no network), so it works fine after
  lockdown; only the *install* needs GitHub (hence Step 2, pre-lockdown). The loop runs
  fine without skillshare — the sync step no-ops when it's absent.
- **Egress audit:** `sudo tail -f /var/log/squid/access.log` — denied hits to odd
  hosts are the prompt-injection / supply-chain signal.
- **Updating the allowlist:** edit `allowed-domains.txt` here, re-run `provision.sh`
  (or copy to `/etc/squid/` + `sudo systemctl reload squid`).
- **Tightening later:** per-repo unix users + per-uid nft rules (§9 "stronger");
  TLS-terminating MITM proxy for Class B (§6).
- The runner reaches the assistant via the agent's **login shell** (so fnm/Node and
  `claude` are on PATH) — always invoke via `sudo -iu agent` or `su - agent`.
