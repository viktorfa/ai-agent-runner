#!/usr/bin/env bash
# The integrator's combined-tree gate: run the full quality suite on staging after a
# merge. Exit 0 iff green; a non-zero exit rolls the merge back and parks the task.
set -euo pipefail
pnpm check
