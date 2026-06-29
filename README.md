# agent-runner

The typed core that runs headless coding agents (Claude Code, Codex; OpenCode
later) against a repo: select work, build the per-tool argv, run the loop, parse
the result, commit + push, and keep a transcript. Plus the **control plane** that
runs as the trusted operator — `dispatch` (run now), `enqueue` (queue a one-off), a
per-repo `watch` loop, and an operator **TUI** (`tui/`).

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
  enqueue             control plane: queue a one-off run; the watcher runs it at the next free slot
  watch               control plane: poll loop for one repo (or all) — drains the board, runs queued
                      one-offs, records per-run status; runs as a systemd --user unit
control/              operator registry templates + systemd units (single + per-repo template); see control/README.md
tui/                  operator dashboard (Bubble Tea v2, separate Go module); see tui/README.md
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
- **Parallel agents in one repo** (planned, not yet built): worktree-isolated
  branches, area leases for conflict prevention, a serialized gated merge to a staging
  branch, and the director testing the UI instead of reviewing diffs — design + the
  decisions behind it in `docs/PARALLEL_AGENTS.md`.

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

**Idle watchdog** (`.agent/config.json` → `agentIdleTimeoutSec`, default `480`): if
the agent produces no output for this long it's killed (process group and all), so a
hung assistant — e.g. codex stuck retrying a stalled API stream — can't wedge a drain
indefinitely. A killed agent emits no `turn.completed`, so it flows into the normal
agent-failure handling. The default sits well above a healthy run's longest quiet gap
(~70s observed); raise it for a repo whose hooks run very long, silent commands.

**Operation** is normally via the control plane, not these commands directly:
`bin/dispatch <repo> [opts]` (run now, drops to the repo's user), `bin/enqueue <repo>
[opts]` (queue a one-off the watcher picks up at the next free slot), and a per-repo
`bin/watch` loop as a systemd `--user` unit — see `control/README.md`. The `tui/`
dashboard gives an at-a-glance fleet view plus the common actions — see `tui/README.md`.
For the host isolation (per-repo Linux user, nftables egress lock, Squid allowlist)
see `backends/host/README.md`.

## Onboarding a host/repo
`backends/host/provision.sh` (parameterized by `AGENT_USER`) creates the user + Squid
base; the toolchain install, clone, git config, PAT, and agent CLI **login** are
manual (login + PAT can't be automated). See `backends/host/README.md`.
