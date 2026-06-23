#!/usr/bin/env bash
set -euo pipefail

# agent-runner/bin/agent-loop.sh → RUNNER_DIR = agent-runner/.
RUNNER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Operate in the workspace (the repo). The caller cd's here; default to $PWD.
WORKSPACE="${WORKSPACE:-$PWD}"
cd "$WORKSPACE"

# Per-repo config seam: prompt paths, hook paths, image (see .agent/config.sh).
if [ -f .agent/config.sh ]; then
  # shellcheck disable=SC1091
  . .agent/config.sh
fi

ASSISTANT=""
LOOP_KIND=""
ITERATIONS=""
MODEL=""
EFFORT=""
LOG_FILE=""
LABEL=""

usage() {
  cat <<'EOF'
Usage: agent-runner/bin/agent-loop.sh --assistant <claude|codex> --loop <dev|qa> [options]

Options:
  --assistant <name>   Assistant CLI to run: claude, codex
  --loop <role>        dev = Implementer (does ready tasks, all areas incl. 3d);
                       qa  = Explorer (tests + 3D audit, files drafts)
  --iterations <n>     Number of iterations
  --model <name>       Model override
  --effort <level>     Reasoning/effort level. Claude accepts: low, medium, high, max.
                       Codex forwards this to model_reasoning_effort in config.
  --log-file <path>    Override log file path
  --label <text>       Override iteration label
  -h, --help           Show this help

Examples:
  agent-runner/bin/agent-loop.sh --assistant codex --loop dev --iterations 1
  agent-runner/bin/agent-loop.sh --assistant codex --loop qa --iterations 1 --model gpt-5.4-mini --effort medium
  agent-runner/bin/agent-loop.sh --assistant claude --loop dev --iterations 1 --model claude-sonnet-4-6 --effort high
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --assistant)
      ASSISTANT=${2:?missing value for --assistant}
      shift 2
      ;;
    --loop)
      LOOP_KIND=${2:?missing value for --loop}
      shift 2
      ;;
    --iterations)
      ITERATIONS=${2:?missing value for --iterations}
      shift 2
      ;;
    --model)
      MODEL=${2:?missing value for --model}
      shift 2
      ;;
    --effort)
      EFFORT=${2:?missing value for --effort}
      shift 2
      ;;
    --log-file)
      LOG_FILE=${2:?missing value for --log-file}
      shift 2
      ;;
    --label)
      LABEL=${2:?missing value for --label}
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

if [ -z "$ASSISTANT" ] || [ -z "$LOOP_KIND" ]; then
  usage
  exit 1
fi

case "$ASSISTANT" in
  claude) ;;
  codex) ;;
  *)
    echo "ERROR: Unsupported assistant: $ASSISTANT"
    exit 1
    ;;
esac

case "$LOOP_KIND" in
  dev|qa) ;;
  *)
    echo "ERROR: Unsupported loop kind: $LOOP_KIND"
    exit 1
    ;;
esac

if [ -z "$ITERATIONS" ]; then
  case "$LOOP_KIND" in
    dev) ITERATIONS=40 ;;
    qa) ITERATIONS=20 ;;
  esac
fi

default_prompt_file() {
  # Resolved from the per-repo config seam: PROMPT_<assistant>_<loop>.
  local var="PROMPT_${ASSISTANT}_${LOOP_KIND}"
  printf '%s\n' "${!var:-}"
}

default_log_file() {
  case "$ASSISTANT:$LOOP_KIND" in
    claude:dev) echo "loop/loop.log" ;;
    claude:qa) echo "loop/qa-loop.log" ;;
    codex:dev) echo "loop/codex-loop.log" ;;
    codex:qa) echo "loop/codex-qa-loop.log" ;;
  esac
}

default_label() {
  case "$ASSISTANT:$LOOP_KIND" in
    claude:dev) echo "Iteration" ;;
    claude:qa) echo "QA Iteration" ;;
    codex:dev) echo "Codex Iteration" ;;
    codex:qa) echo "Codex QA Iteration" ;;
  esac
}

PROMPT_FILE=$(default_prompt_file)
LOG_FILE=${LOG_FILE:-$(default_log_file)}
LABEL=${LABEL:-$(default_label)}

if [ ! -f "$PROMPT_FILE" ]; then
  echo "ERROR: Prompt file not found: $PROMPT_FILE"
  exit 1
fi

mkdir -p loop
echo "=== Run started at $(date -Iseconds) ===" >> "$LOG_FILE"

echo "Setting up $ASSISTANT environment..."
git config user.name >/dev/null 2>&1 || git config --global user.name viktorfa
git config user.email >/dev/null 2>&1 || git config --global user.email vikfand@gmail.com

# Headless runs have no use for Claude Code's statsig/telemetry/autoupdater traffic,
# and it logs "Failed to resolve statsig.anthropic.com" noise. Disable all of it.
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

if [ "${DEVCONTAINER:-}" = "true" ]; then
  export npm_config_store_dir=/home/node/.pnpm-store
fi

if [ "$ASSISTANT" = "claude" ] && [ "${DEVCONTAINER:-}" = "true" ]; then
  cp /tmp/host-claude.json /home/node/.claude.json 2>/dev/null || true
fi

if [ "$ASSISTANT" = "codex" ]; then
  sh "$RUNNER_DIR/lib/setup-codex-home.sh"
fi

echo "Setup complete."

if [ "${AGENT_LOOP_DEBUG:-}" = "1" ]; then
  echo "Agent loop debug environment:"
  env | grep -E '^(CODEX|OPENAI|DEVCONTAINER|PNPM_HOME|PATH)=' | sort || true
fi

run_claude_once() {
  local cmd=(claude -p --verbose --dangerously-skip-permissions --output-format=stream-json)

  if [ -n "$MODEL" ]; then
    cmd+=(--model "$MODEL")
  fi

  if [ -n "$EFFORT" ]; then
    cmd+=(--effort "$EFFORT")
  fi

  local output
  output=$(cat "$PROMPT_FILE" | "${cmd[@]}" 2>&1 | tee -a "$LOG_FILE")

  if echo "$output" | grep -q '"error":"authentication_failed"'; then
    echo ""
    echo "ERROR: Not logged in. Run 'claude login' first."
    exit 1
  fi
}

run_codex_once() {
  local cmd=(
    codex
    -s danger-full-access
    -a never
    -c shell_environment_policy.inherit=all
    exec
    --json
    --dangerously-bypass-approvals-and-sandbox
    -C /workspace
  )

  if [ -n "$MODEL" ]; then
    cmd+=(--model "$MODEL")
  fi

  if [ -n "$EFFORT" ]; then
    cmd+=(-c "model_reasoning_effort=\"$EFFORT\"")
  fi

  cat "$PROMPT_FILE" | "${cmd[@]}" 2>&1 | tee -a "$LOG_FILE"
}

i=1
while [ "$i" -le "$ITERATIONS" ]; do
  echo ""
  echo "=== $LABEL $i / $ITERATIONS ==="
  echo ""

  if [ "$ASSISTANT" = "claude" ]; then
    run_claude_once
  else
    run_codex_once
  fi

  i=$((i + 1))
  sleep 2
done

echo ""
echo "Loop finished. $ITERATIONS iterations completed."
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Recent commits:"
  git log --oneline -10
fi
