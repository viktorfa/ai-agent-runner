---
id: TASK-3
title: >-
  Runner: stamp dispatched model/effort into the transcript so metrics attribute
  overrides correctly
status: Done
assignee: []
created_date: '2026-07-11 17:43'
updated_date: '2026-07-11 18:01'
labels:
  - 'area:metrics'
  - 'risk:low'
dependencies: []
references:
  - control/bin/drain-metrics-extract
  - src/args.ts
  - src/orchestrate.ts
priority: medium
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The drain-metrics collector (control/bin/drain-metrics-extract) attributes model/effort by reading .agent/config.json at the drain's merged auto/work commit. That is correct for config-driven model switches, but WRONG for one-off dispatch overrides: 'dispatch <repo> --task X --model gpt-5.6-sol --effort high' still gets labeled with the committed config's model. This blocks a clean per-task A/B (e.g. 2 tasks on sol, 2 on luna in the same window) and any override-based comparison.

Fix: at drain time, after the runner resolves the effective model/effort (src/args.ts: 'args.model ?? config.model', 'args.effort ?? config.effort'), record them where the extractor can read them. Simplest: extend the transcript header the runner already writes (# agent-runner orchestrate / # config loaded from ... / # assistant codex/dev) with e.g. '# model <id>' and '# effort <level>'. Then teach control/bin/drain-metrics-extract to prefer those header lines, falling back to the merged-commit .agent/config.json for older transcripts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Each drain transcript records the effective model + effort actually passed to codex, including when set via --model/--effort override
- [x] #2 drain-metrics-extract reads model/effort from the transcript when present, falling back to the merged-commit .agent/config.json for older logs
- [x] #3 A one-off 'dispatch <repo> --task X --model gpt-5.6-sol --effort high' yields a drains.csv row with model=gpt-5.6-sol effort=high, not the committed config's values
<!-- AC:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-07-11 18:01
---
Implemented effective model/effort transcript headers, transcript-first metrics extraction with merged-commit config fallback, and explicit-task extraction for one-off dispatch rows. Modified: src/cli.ts, control/bin/drain-metrics-extract, control/bin/collect-metrics, control/README.md. Verified: pnpm check, extractor override/legacy fallback test, CLI override transcript smoke test.
---
<!-- COMMENTS:END -->
