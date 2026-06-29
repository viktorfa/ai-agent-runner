#!/usr/bin/env bash
# Workspace prep for an agent-runner work session: install deps so the quality gates
# (lint, typecheck, test) can run in this worktree.
set -euo pipefail
pnpm install --frozen-lockfile
