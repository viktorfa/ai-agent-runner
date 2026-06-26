# agent-runner

The typed core that runs headless coding agents (Claude Code, Codex; OpenCode
later) against a repo: select work, build the per-tool argv, run the loop, parse
the result, commit + push, and keep a transcript. Plus the **control plane** that
triggers runs as the trusted operator (`bin/dispatch`).

It is **self-contained** — its own `tsconfig.json`, `biome.json`, dev toolchain,
and tests. Extracted from the `room_planner` monorepo (where it was incubated) into
this standalone repo; it operates on any repo via `--workspace` + that repo's
`.agent/` config, and runs nothing repo-specific.

## Layout
```
src/
  types.ts            Assistant/RunOptions/AgentResult/AgentAdapter
  adapters/{claude,codex}.ts   per-tool buildArgv + parseResult (the quirks, typed)
  prompt.ts           assemblePrompt(base, task?) — the --task directive
  git.ts              fetch/reset/merge/unmerged-count + force-with-lease push
  config.ts           AgentConfig (assistant/model/effort/workBranchMode) + loadConfig(.agent/config.json)
  run.ts              runLoop(opts, deps) — iterations / drain + stall-detection
  orchestrate.ts      fetch + prepare work branch (reset|accumulate) + setup + runLoop
  args.ts             parseArgs — the CLI surface
  log-path.ts         runLogPath — transcript path
  io.ts               real spawn/fs/push/git + transcript sink (OS-glue edge)
  cli.ts              entry: run | orchestrate
bin/
  agent-runner        host entry: runs cli.ts via tsx directly
  dispatch            control plane: run as the operator, drops to a repo's user (flock'd)
  watch               control plane: poll loop (systemd --user) — drains each repo
control/              operator registry templates + systemd unit (see control/README.md)
```

## Design
- **TypeScript owns the decisions** (selection, argv, parsing, loop, orchestrate),
  unit-tested with injected deps. **Bash owns OS-glue** (entry shims, provisioning).
- **Adapters** isolate per-tool quirks: add a tool by implementing `AgentAdapter`
  (`bin`, `buildArgv`, `parseResult`), not by editing the loop.
- **Isolation is the host layer** — a dedicated per-repo Linux user + nftables
  egress lock + a Squid allowlist proxy (see `backends/host/`). The runner runs the
  agent directly in the workspace; the jail lives below it.
- The runner is **env-agnostic**: it reads each repo's `.agent/` via `--workspace`
  and never hardcodes machine paths (the dispatch loads the machine's toolchain).
- **Board:** the runner queries readiness with `pnpm exec backlog task list`
  (`io.ts`), so a repo using the runner must use **Backlog.md + pnpm** (or this
  becomes a `.agent/` hook later).

## Commands
```bash
pnpm check          # lint + typecheck + test (self-contained)
pnpm test           # vitest
pnpm typecheck      # tsgo --noEmit
pnpm lint           # biome check .

# one session (fetch nothing; just run the agent against the current tree):
bin/agent-runner run --assistant codex --workspace "$PWD" --task TASK-12

# a full run (fetch + prepare work branch + setup + loop):
bin/agent-runner orchestrate --workspace "$PWD" \
  --proxy http://127.0.0.1:3128 --drain --force
```
Key flags: `--task <id>` (one task) or `--drain` (work the board until empty),
`--iterations N`, `--proxy`, `--no-push`, `--force`.

**Config precedence:** CLI flag → the repo's `.agent/config.json` → built-in
default. So `assistant`, `model`, `effort`, and `workBranchMode` live in
`.agent/config.json` (versioned with the repo); the registry supplies only the
machine binding (path/user/proxy); `role` is per-dispatch (default `dev`).

**Work-branch mode** (`.agent/config.json` → `workBranchMode`): `reset` (clean diff
per run, guarded — review per PR) or `accumulate` (keep `auto/work`, merge base in,
stack tasks — merge to base periodically), chosen per repo.

**Operation** is normally via the control plane, not these commands directly:
`bin/dispatch <repo> [opts]` (run as the operator → drops to the repo's user) and
`bin/watch` (the systemd poll loop). See `control/README.md`.

See `docs/AGENT_DEV_SYSTEM.md` for the full system (isolation, security, the
control plane, the responsibility split).

## Extracting to its own repo
The decoupling is done (own tsconfig/biome/deps; no repo-specific code). The move:
1. `biome.json`: flip `"root": false` → `true` (it inherits the monorepo root today).
2. Remove `agent-runner` from the monorepo's `pnpm-workspace.yaml`, root
   `biome.json` includes, and root `vitest.config.ts` projects.
3. `git subtree split --prefix=agent-runner` → push to the new (private) remote.
4. On the executor, clone it once at a stable path (e.g. `/home/agent/agent-runner`)
   and point `bin/dispatch`'s `runner=` at it instead of `<workspace>/agent-runner`.
   Then the `git checkout -B` pre-sync in `dispatch` (which only bootstraps the
   runner code from inside the product repo) can be dropped — `orchestrate` already
   manages the product workspace's git, and the runner is updated by `git pull` in
   its own clone, independent of any product repo.
5. Point the systemd unit's `ExecStart` at the new `…/agent-runner/bin/watch`.

**Onboarding a host/repo** is provisioning, separate from extraction:
`backends/host/provision.sh` (parameterized by `AGENT_USER`) creates the user +
Squid base; the toolchain install, clone, git config, PAT, and agent CLI **login**
are manual (login + PAT can't be automated). A `provision-repo.sh` that scripts the
mechanical parts is a future convenience — not needed to extract.
