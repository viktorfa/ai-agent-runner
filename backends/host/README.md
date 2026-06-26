# Host backend — executor provisioning runbook

Docker-free isolation for the agent runner: a dedicated **`agent`** user, a
**Squid** allowlist forward proxy (no TLS interception), and an **nftables**
egress drop that confines the agent uid to the proxy. Design + rationale: the
repo `README.md`.

These files are the source of truth; `provision.sh` / `lockdown.sh` install them
to `/etc`. The agent user gets **its own fnm** (not system Node).

Two clones live on the executor: **this runner repo** (the tooling, at
`/home/agent/agent-runner`) and **each product repo** the agent works on (at
`/home/agent/repos/<repo>`). The runner is updated with `git pull` in its own
clone; each product repo is managed by `orchestrate`.

> **Order matters:** do all toolchain/clone/install steps while the agent still
> has open egress, then run `lockdown.sh` last to close the door.

Placeholders below: `<YOU>` = your GitHub user, `<REPO>` = a product repo,
`<RUNNER_URL>` = this repo's git URL.

---

## Step 0 — [you] get this repo onto the executor

`provision.sh` needs these files. Clone this repo (public → no auth needed):

```
git clone <RUNNER_URL> /tmp/agent-runner   # or anywhere your user can read
```

## Step 1 — [root] base: agent user + Squid

```
sudo AGENT_USER=agent bash /tmp/agent-runner/backends/host/provision.sh
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
# skillshare (optional): materializes a repo's skills — .agent/setup.sh runs
# `skillshare sync` each loop. Installs to ~/.local/bin (on PATH, no sudo).
INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://raw.githubusercontent.com/runkids/skillshare/main/install.sh | sh
# codex (if a repo uses it):  npm i -g @openai/codex   (then `codex login`)
```

## Step 3 — [you] restricted GitHub credential + branch protection (per product repo)

**Fine-grained PAT (web UI only — `gh` can't mint these).** Settings → Developer
settings → Fine-grained tokens → Generate:
- Repository access: *Only select repositories* → `<REPO>`
- Permissions: **Contents: Read and write** + **Metadata: Read** (auto). Nothing else.
  ("Contents" *is* the git permission — Read = clone/fetch/pull, Read+write adds
  push; there's no separate push/pull toggle.)

**Protect the base branch with a ruleset (`gh`, run from a machine where gh is
authed).** Because the runner authenticates as *you* (your PAT), this blocks direct
pushes to the base branch for everyone and routes landing through a quick self-PR;
`auto/work` stays unrestricted so the runner pushes there freely:

```bash
gh api --method POST repos/<YOU>/<REPO>/rulesets --input - <<'EOF'
{ "name": "Protect base", "target": "branch", "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false, "require_last_push_approval": false,
        "required_review_thread_resolution": false } },
    { "type": "non_fast_forward" }, { "type": "deletion" } ] }
EOF
```

Keep the PAT for Step 4.

## Step 4 — [agent] git config + clones + deps

```bash
# still as agent, open egress.

# Commit identity (distinguishable, so runner commits stand out — or use your own):
git config --global user.name  "<REPO> agent"
git config --global user.email "<YOU>+agent@users.noreply.github.com"

# Pre-seed the PAT so headless pushes never hit a prompt (0600, agent-owned).
git config --global credential.helper store
printf 'https://<YOU>:%s@github.com\n' 'PASTE_YOUR_PAT_HERE' > ~/.git-credentials
chmod 600 ~/.git-credentials

# The runner (this repo) — its own clone, updated with `git pull`.
git clone <RUNNER_URL> ~/agent-runner

# Each product repo the agent works on, + the branch it pushes to.
mkdir -p ~/repos && cd ~/repos
git clone https://github.com/<YOU>/<REPO>.git
cd <REPO> && git checkout -b auto/work

# Route the agent's git through Squid. REQUIRED for any manual git (fetch/pull/push)
# after lockdown — the interactive shell has no HTTPS_PROXY, so direct git is dropped
# by nftables. (Runs via dispatch are fine — the CLI sets the proxy env from --proxy.)
git config --global http.proxy  http://127.0.0.1:3128
git config --global https.proxy http://127.0.0.1:3128

# Runner deps; product deps; the chromium binary for playwright-cli.
cd ~/agent-runner && pnpm install
cd ~/repos/<REPO> && pnpm install
playwright-cli install-browser chromium   # browser binary into agent's cache
```

Chromium's **system libraries** need apt (root), and `playwright-cli` doesn't
install them. Run once **as a sudo user** (who has pnpm) so the libs land
system-wide for the agent's chromium:

```bash
pnpm dlx playwright install-deps chromium
```

## Step 5 — [root] close egress (lockdown)

```
sudo AGENT_USER=agent bash /tmp/agent-runner/backends/host/lockdown.sh
```

Applies the nftables allowlist and prints verification commands (example.com must
fail; api.github.com via the proxy must work). Run them.

## Step 6 — [you] smoke test one run

Mark a task ready on the board if needed (`pnpm exec backlog task list --plain`),
then trigger a run from your operator user (the control plane) via dispatch:

```
~agent/agent-runner/bin/dispatch <repo> --task <id>
```

(or `--drain` to work the whole board). `dispatch` drops to the agent user via
`sudo`, then runs `agent-runner orchestrate`: it fetches, prepares `auto/work` per
the repo's `workBranchMode`, runs `.agent/setup.sh`, and runs the loop — pushing
`auto/work` to `origin` after each successful task. Back on your machine:
`git fetch origin auto/work && git log --oneline origin/auto/work -5`.

Set up the operator registry + the passwordless sudoers rule + the systemd watcher
that automates all of this — see **`control/README.md`**.

---

## Notes
- **Loop prompts / hooks** live in each product repo's `.agent/` and work on a fresh
  clone — no sync needed.
- **Repo skills** are a skillshare-synced *output*: source in a repo's
  `.skillshare/skills/`, gitignored at `.claude/skills/`. `.agent/setup.sh` runs
  `skillshare sync` each loop, so they materialize automatically. `sync` is
  local-only (works after lockdown); only the *install* needs GitHub (Step 2). The
  loop runs fine without skillshare — the sync step no-ops when it's absent.
- **Egress audit:** `sudo tail -f /var/log/squid/access.log` — denied hits to odd
  hosts are the prompt-injection / supply-chain signal.
- **Updating the allowlist:** edit `allowed-domains.txt`, re-run `provision.sh`
  (or copy to `/etc/squid/` + `sudo systemctl reload squid`).
- **Tightening later:** per-repo unix users + per-uid nft rules; a TLS-terminating
  MITM proxy for higher-risk repos.
- The runner reaches the assistant via the agent's **login shell** (so fnm/Node and
  the agent CLIs are on PATH) — always invoke via `sudo -iu agent`.
