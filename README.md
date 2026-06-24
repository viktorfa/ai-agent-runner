# agent-runner

The typed core that runs headless coding agents (Claude Code, Codex; OpenCode
later) against a repo: select work, build the per-tool argv, run the loop, parse
the result, commit + push, and keep a transcript. Plus the **control plane** that
triggers runs as the trusted operator (`bin/dispatch`).

It is **self-contained** — its own `tsconfig.json`, `biome.json`, dev toolchain,
and tests — so it can be lifted into its own repository later. For now it lives
in this monorepo so we can gain practical experience before splitting it out.

## Layout
```
src/
  types.ts            Assistant/Backend/RunOptions/AgentResult/AgentAdapter
  adapters/{claude,codex}.ts   per-tool buildArgv + parseResult (the quirks, typed)
  prompt.ts           assemblePrompt(base, task?) — the --task directive
  git.ts              fetch/reset/unmerged-count + force-with-lease push args
  config.ts           AgentConfig + loadConfig(<workspace>/.agent/config.json)
  run.ts              runLoop(opts, deps) — iterations / drain; deps injected
  orchestrate.ts      fetch + unmerged guard + reset auto/work + setup + runLoop
  args.ts             parseArgs — the CLI surface
  log-path.ts         runLogPath — transcript path
  io.ts               real spawn/fs/push/git + transcript sink (OS-glue edge)
  cli.ts              entry: run | orchestrate
bin/
  agent-runner        host entry: runs cli.ts via tsx directly
  dispatch            control plane: run as viktor, drops to a repo's user
control/              operator registry templates + setup (see control/README.md)
```

## Design
- **TypeScript owns the decisions** (selection, argv, parsing, loop, orchestrate),
  unit-tested with injected deps. **Bash owns OS-glue** (entry shims, provisioning).
- **Adapters** isolate per-tool quirks: add a tool by implementing `AgentAdapter`
  (`bin`, `buildArgv`, `parseResult`), not by editing the loop.
- **Backend = isolation mechanism** (`host` = per-user uid + nftables + Squid;
  `docker` = container), orthogonal to which machine runs it.
- The runner is **env-agnostic**: it reads each repo's `.agent/` via `--workspace`
  and never hardcodes machine paths (the dispatch loads the machine's toolchain).

## Commands
```bash
pnpm check          # lint + typecheck + test (self-contained)
pnpm test           # vitest
pnpm typecheck      # tsgo --noEmit
pnpm lint           # biome check .

# one session (fetch nothing; just run the agent against the current tree):
bin/agent-runner run --assistant codex --workspace "$PWD" --task TASK-12

# a full run (fetch + guard + reset auto/work + setup + loop):
bin/agent-runner orchestrate --assistant codex --backend host \
  --proxy http://127.0.0.1:3128 --workspace "$PWD" --drain --force
```
Key flags: `--task <id>` (one task) or `--drain` (work the board until empty),
`--iterations N`, `--backend host|docker`, `--proxy`, `--no-push`, `--force`.

See `docs/AGENT_DEV_SYSTEM.md` for the full system (isolation, security, the
control plane, the responsibility split) and `control/README.md` for dispatch.

## Extracting to its own repo (later)
The decoupling is done; the move is mechanical:
1. `biome.json`: flip `"root": false` → `true` (it inherits the monorepo root today).
2. Remove `agent-runner` from the monorepo's `pnpm-workspace.yaml`, root
   `biome.json` includes, and root `vitest.config.ts` projects.
3. `git subtree split --prefix=agent-runner` → push to the new remote.
4. On the executor, clone it once at a stable path and point `bin/dispatch`'s
   `runner=` at that path instead of `<workspace>/agent-runner`.
