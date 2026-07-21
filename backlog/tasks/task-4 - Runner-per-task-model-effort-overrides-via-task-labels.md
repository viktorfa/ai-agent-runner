---
id: TASK-4
title: 'Runner: per-task model/effort overrides via task labels'
status: To Do
assignee: []
created_date: '2026-07-21 11:47'
labels:
  - 'area:runner'
  - 'area:metrics'
  - 'risk:low'
dependencies: []
priority: medium
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Outcome

The orchestrator can escalate a single hard task to a stronger model by labeling it, without changing the repo default or the drain dispatch. Metrics attribution stays correct when a drain mixes models.

## Context (carry the diagnosis)

Today model/effort are resolved once per drain (args.ts:119, `args.model ?? config.model`) and the same RunOptions is reused for every codex spawn in that drain — even though each task already runs as its own codex process (adapters/codex.ts:45 takes per-spawn --model/--effort) and parseTask already reads frontmatter labels for area: leases. Floorplanner data (2026-07-15 join of drains.csv × task-reviews.jsonl) picked gpt-5.6-luna xhigh as the default, with sol-high as a plausible per-task escalation — that pattern needs per-task overrides plus correct attribution.

## Design (decided — no forks)

- A task may carry labels `model:<id>` and `effort:<level>` (e.g. `model:gpt-5.6-sol`, `effort:high`). First such label wins; a label with an empty value is ignored.
- Per-task resolution order: **task label ?? dispatch flag ?? config**. A drain-level --model override must NOT downgrade a task explicitly labeled for escalation.
- TaskMeta gains optional `model` / `effort` fields parsed from labels.
- Transcript: stamp one line per dispatched task at spawn time, with the RESOLVED values: `# task-model <TASK-ID> <model|-> <effort|->` (`-` when nothing resolved, i.e. codex default). The existing per-run `# model`/`# effort` header lines stay as the drain-level dispatch record.
- drain-metrics-extract: append a new LAST column `task_models` to the CSV row — space-separated `TASK-ID=model/effort` entries, only for tasks whose resolved pair differs from the row-level model/effort; empty string when the drain is uniform (the common case). Old rows keep parsing (column is appended last; csv.DictReader tolerates its absence in old rows).
- **Out of scope:** per-task token accounting — codex JSONL streams from parallel tasks interleave in one transcript, so usage cannot be split per task reliably. Do not attempt it.

## Reference

- src/args.ts:119 (current drain-level resolution), src/adapters/codex.ts:45 (per-spawn --model), src/task.ts (label parsing precedent), src/cli.ts:88 (header stamping), control/bin/drain-metrics-extract (CSV emit), control/README.md metrics schema section.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 parseTask exposes optional model/effort from `model:`/`effort:` labels; tests cover present, absent, and empty-value labels
- [ ] #2 Each task's agent spawn resolves model/effort as task-label ?? dispatch-flag ?? config; a task without labels behaves exactly as today (test pins this), and a labeled task overrides a drain-level --model flag (test pins this too)
- [ ] #3 The drain transcript contains one `# task-model <TASK-ID> <model|-> <effort|->` line per dispatched task, stamped at spawn with resolved values
- [ ] #4 drain-metrics-extract emits the trailing `task_models` column: empty for uniform drains, `TASK-ID=model/effort` entries for tasks deviating from the row-level pair; verified against a synthetic mixed-model transcript, and existing CSV rows still parse
- [ ] #5 control/README.md metrics schema documents the new column and the label convention
<!-- AC:END -->
