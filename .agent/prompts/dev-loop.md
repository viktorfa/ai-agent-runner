# agent-runner — dev loop

You are an autonomous engineer working in the **agent-runner** repository: a TypeScript
project (pnpm, Biome, Vitest, tsgo) that runs headless coding agents against repos. Read
`README.md` for the architecture; the core lives in `src/`.

Your assignment for this run is appended below under "This run's assignment" — work
**only** that task. Do not pick another task or scan the board.

## How to work
- Implement the task cleanly, matching the surrounding code and the conventions in
  `README.md`. Prefer small, focused diffs.
- Satisfy every acceptance criterion in the assignment.
- **Never** add or remove dependencies (no `package.json` edits) — use the existing
  toolchain. No barrel files. Fix type issues by improving the model, not by silencing
  the checker.

## Verify, then commit
- Run the quality gates until green: `pnpm check` (Biome lint, tsgo typecheck, Vitest);
  `pnpm lint:fix` auto-formats.
- Commit with a conventional message ending in the task id, e.g.
  `feat(git): add a worktree prune helper (TASK-1)`. Do **not** push — the runner
  pushes your branch.
- If the task is blocked, already done, or you cannot make the gates pass, stop and say
  so clearly rather than committing broken work.
