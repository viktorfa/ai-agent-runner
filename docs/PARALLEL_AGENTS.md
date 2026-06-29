# Parallel agents in one repo

Status: **partially built.** The parallel dispatch core (worktree pool + area-lease
scheduler), serialized gated integrator, published staging accumulation, explicit
director lifecycle commands (`status`, `promote`, `discard`), and read-only TUI
surfacing of staging + in-flight worktrees are implemented. Richer per-task summaries
and TUI-driven `promote`/`discard` are not yet (see *Phasing*). This doc captures the
plan and the know-how — the decisions (and rejected alternatives) so they don't get
re-litigated. When a phase ships, fold the operational details into the relevant
README and trim this doc to what's still forward-looking.

## What the remote executor is for

The executor is an **autonomous low-risk task runner**. The human is a **director** —
sets goals, tests the UI, glances at patterns — **not a code reviewer.** Anything
important enough to read line-by-line is done in the human's own interactive session
on their machine and **never runs here.** That single fact drives the whole design:
since no human reads the diff, *the gates are the gate*, and correctness rests on
automated checks + genuinely low-risk scoping + the human testing the integrated UI.

## Deliberately rejected (and why)

- **Adopting Gas Town (the full swarm orchestrator).** Its value is *removing* the
  human; we keep the human as director. It's expensive (~$100/hr reported), chaotic,
  has auto-merged red, and imports a "never review generated code" philosophy we
  reject. We borrow ideas (worktrees, a gated merge queue, per-task execution
  metadata), not the system.
- **PR-review-as-gate.** The director does not review diffs. Gates — not humans —
  decide what lands.
- **An agent resolving `<<<<<<<` conflict markers and landing it.** Produces
  frankenmerges that can pass tests yet be semantically wrong. We *redo the task on a
  fresh base* instead (see Conflicts).
- **An LLM "Mayor" daemon.** The control plane stays deterministic (bash + systemd +
  flock); the human's local planning session is the Mayor.
- **A scope guard** (rejecting branches that edit outside their declared area).
  Deferred — add only if agents actually stray in practice. Try without it first.

## The model

```
ready task (anything except risk: needs-human)
  → git worktree + branch auto/<task-id>              isolation: no shared working tree
  → agent works ONE task, self-checks vs acceptance criteria
  → per-branch gates (lint / typecheck / test / build / qa)
  → serialized merge into STAGING (auto/work): one at a time,
      re-run the FULL gates on the COMBINED tree, NEVER keep red
  → preview deploys STAGING → director tests the UI, glances at patterns
  → director PROMOTES staging→master (a deliberate batch gesture, not a per-diff review)
      or discards / redirects

risk: needs-human  →  not pulled here; left for the director's local session
```

`master` stays clean. The executor runs free on `auto/work`. Promotion to `master` is
a deliberate human act at the *outcome* level, not diff review.

This is a shift for `orchestrate.ts`: from "drain → shared `auto/work`" (sequential)
to "parallel dispatch → branch-per-task → serialized gated merge." `workBranchMode`'s
per-run reset/accumulate is superseded here by per-task branches off `master`.

## Mechanisms (the know-how)

1. **Worktree isolation.** `git worktree` per concurrent agent, each on its own
   `auto/<task-id>`. Worktrees share the `.git` object store but have independent
   working dirs + indexes → agents physically cannot clobber each other's files. Plumbing
   caveats: git refuses to check out the same branch in two worktrees (ours are
   distinct), and `git worktree prune` must run on cleanup. `node_modules` is per
   working dir, so `setup` runs per worktree — cheap via pnpm's content-addressed
   store (hardlinks), not free.
2. **Dynamic hook ports.** With N parallel agents, `dev-server` / `preview` / `audit`
   hooks must each bind a unique port. (Previously deferrable; parallelism makes it
   real — a prerequisite, not an extra.)
3. **Task metadata** — the steering *and* scheduling substrate, on each task:
   - `risk: needs-human` — an explicit **opt-out**: the director will do this one in
     their own session, so the executor skips it. Any other (or no) risk is dispatchable
     — the executor takes ready work by default, it doesn't require a `risk:low` label.
   - `area:*` — declared files/areas; an **optional** lease for conflict prevention.
   - `blocked-by` — dependency edges; only unblocked tasks are dispatched.
   - acceptance criteria + definition-of-done — the agent self-verifies against these.
4. **Area leases (conflict *prevention*, opt-in).** When tasks *declare* areas, the
   scheduler won't run two concurrently whose areas overlap, so declared work edits
   disjoint areas and doesn't textually conflict at merge. Labelling is **not** required
   to dispatch: a task with no declared area just runs, and a conflict between two such
   tasks is caught downstream by the gated integrator (§5–6) — labelling buys fewer
   re-runs, not permission to run. Decomposition quality still governs throughput:
   undeclared overlap trades a cheap lease for a costlier park-and-redo.
5. **Serialized gated integrator (single-flight).** Merges one branch at a time into
   `auto/work` and **re-runs the full gates on the combined tree** — the only thing
   that catches *semantic* conflicts git sees no marker for (A renames, B calls it from
   elsewhere). It resumes from published `origin/auto/work` when present, otherwise
   starts from `origin/<base>`, and publishes green staging with force-with-lease.
   Nothing stays on `auto/work` that isn't green.
6. **Conflict / red resolution.** On a textual conflict or red combined-tree gates:
   **park and re-dispatch on the fresh base** — a new worktree off the current
   `auto/work`, agent reimplements the task on top of the conflicting change, yielding a
   clean gate-checkable diff. If it re-conflicts or is touchy, escalate to
   `needs-human`. Never blind marker-resolution; never land red.
7. **Staging + promote.** Director tests the `auto/work` preview, then runs
   `agent-runner promote` to fast-forward `master` to `origin/auto/work`, or
   `agent-runner discard` to reset only staging back to `origin/master`.
   `agent-runner status` reports ahead/behind and diffstat. Undo should become one
   gesture in the TUI.
8. **Glanceable summaries, not diffs.** Per task, surface a short "what I did + which
   patterns/approach + files touched" digest in the TUI (the agent already emits summary
   messages). That's the director's "glance at patterns" without reading code.
9. **Steward as autonomous code-health guardian.** Since no human reviews, the steward
   role owns pattern/convention enforcement, dead-code, and doc freshness — promoted to
   a *required* pre-merge check, not a nice-to-have.
10. **Context & business goals (how the director steers without reading code).**
    - `docs/PROJECT_GOALS.md` in each target repo — single source of truth for business
      goals, current priorities, explicit non-goals. The planning session generates and
      prioritizes tasks from it; workers read it for "why."
    - **Per-task brief assembly** — the harness composes each prompt from task +
      acceptance criteria + relevant area docs + goals, not a generic role prompt.
      Giving one focused task with the right context is the biggest context-handling win.

## Phasing (thin, falsifiable slices)

- **Phase 0 — foundations** (useful even at N=1): `PROJECT_GOALS.md`; the task fields
  (`risk`, `touches`, `blocked-by`, acceptance criteria); per-task brief assembly.
  *Falsifiable:* a dispatched agent's prompt contains the goals + area docs; tasks carry
  the fields; the executor skips `needs-human` tasks.
- **Phase 1 — parallel core:** worktree pool + concurrency cap; atomic task claim
  (flock); area-lease scheduler; serialized gated integrator (combined-tree gates, never
  red, park-on-conflict); always-on `auto/work` preview; TUI shows worktrees/branches +
  per-task summaries + `promote`/`discard`. *Falsifiable:* two disjoint tasks run
  concurrently and both land green on staging; an overlapping pair serializes; a red
  merge is parked, not landed; `master` only advances on an explicit promote.
  *Done so far:* worktree pool + cap + area-lease scheduler (`runParallel`); serialized
  gated integrator (`integrate` — merges each green branch into `auto/work` one at a
  time, re-runs `config.gates` on the combined tree, rolls back + parks a red or
  conflicting merge); published staging accumulation across runs; explicit
  `status`/`promote`/`discard` CLI commands; runner-side task-state enforcement that
  only branches whose assigned task is `Done` are eligible for integration; TUI
  surfacing of the staging branch (ahead/behind base) + in-flight per-task worktrees in
  the detail panel (read-only). *Still open:* richer per-task summaries; `promote` /
  `discard` from the TUI (needs a director-intent file the watcher consumes, so the TUI
  stays a pure frontend); the `agent` push credential in any environment where
  publishing staging is not already authorized.
- **Phase 2 — only if needed:** stronger pre-filters; continuation/handoff for long
  tasks (a continuation note on the task; next dispatch resumes).
- **Phase 3 — only if Backlog limits bite:** revisit beads for collision-free parallel
  task *filing* (Backlog's sequential `TASK-N` ids collide) + dependency graph + memory.
  Evaluate a lightweight hash-id scheme before taking on Dolt. Borrow the pattern, not
  necessarily the tool.

## Honest limits

- **Gates are load-bearing.** A gap a human reviewer would catch now ships to staging.
  Mitigation: strong gates + steward + conservative `risk: low` scoping + the director
  testing the UI on staging before promoting. Important work is routed local precisely
  for this reason.
- **Green ≠ correct.** A semantic conflict no test covers can reach staging; the UI test
  before promote is the human backstop, at the outcome level.
- **`touches` is a hint; agents may stray.** Accepted for now (scope guard deferred).
- **Task-state is enforced, not just prompted.** A worker branch is only eligible for
  integration after the assigned task is `Done` in that worker worktree. `To Do`, `In
  Progress`, `Blocked`, or unreadable task state is treated as a failed worker run, so
  partial or unclassified work does not land on staging.
- **Throughput trade.** Heavy overlap serializes; conflicts cost a re-run. That's the
  correct trade — parallelism only where areas are genuinely independent.
