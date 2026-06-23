#!/usr/bin/env bash
set -euo pipefail

# agent-runner/bin/run-agent-loop.sh → RUNNER_DIR = agent-runner/.
RUNNER_DIR="$(cd "$(dirname "$0")/.." && pwd)"

ASSISTANT=""
LOOP_KIND=""
ITERATIONS=""
MODEL=""
EFFORT=""
QA_BASE_URL=${QA_BASE_URL:-}
AGENT_IMAGE=${AGENT_IMAGE:-}
WORKSPACE_PATH="$PWD"
GIT_DIR_PATH=""
GIT_COMMON_DIR_PATH=""
INTERNAL_QA_BASE_URL=""
STATE_NAMESPACE=${AGENT_STATE_NAMESPACE:-}
BASH_HISTORY_VOLUME=${AGENT_BASH_HISTORY_VOLUME:-}
CODEX_CONFIG_VOLUME=${AGENT_CODEX_CONFIG_VOLUME:-}
# Isolation backend (machine-level, not per-repo): docker (default) or host.
BACKEND=${AGENT_BACKEND:-docker}
# Egress proxy for the host backend (the Squid allowlist). See AGENT_DEV_SYSTEM §6.
PROXY_URL=${AGENT_HTTPS_PROXY:-}

usage() {
  cat <<'EOF'
Usage: agent-runner/bin/run-agent-loop.sh --assistant <claude|codex> --loop <dev|qa> [options]

Options:
  --assistant <name>   Assistant CLI to run: claude, codex
  --loop <role>        dev = Implementer (does ready tasks, all areas incl. 3d);
                       qa  = Explorer (tests + 3D audit, files drafts)
  --iterations <n>     Number of iterations
  --model <name>       Model override
  --effort <level>     Reasoning/effort level. Claude accepts: low, medium, high, max.
                       Codex forwards this to model_reasoning_effort in config.
  --qa-base-url <url>  Use an already-running app for QA loops instead of the managed preview
  --backend <name>     Isolation backend: docker (default) or host (Docker-free).
                       Also AGENT_BACKEND env.
  --proxy <url>        host backend: egress proxy (Squid allowlist) for the agent.
                       Also AGENT_HTTPS_PROXY env.
  --workspace <path>   Workspace path (mounted at /workspace for docker; cwd for host)
  -h, --help           Show this help

 docker-backend only:
  --image <name>       Docker image name (default room-planner-claude / .agent/config.sh)
  --git-dir <path>     Override Git dir bind mount
  --state-namespace <name>     Override the per-worktree container state namespace
  --bash-history-volume <name> Override the Docker volume for /commandhistory
  --codex-config-volume <name> Override the Docker volume for /home/node/.codex

Examples:
  agent-runner/bin/run-agent-loop.sh --assistant codex --loop dev --iterations 1
  agent-runner/bin/run-agent-loop.sh --assistant codex --loop qa --iterations 1 --model gpt-5.4-mini --effort medium
  agent-runner/bin/run-agent-loop.sh --assistant codex --loop qa --iterations 1 --qa-base-url http://host.docker.internal:4173
  agent-runner/bin/run-agent-loop.sh --assistant claude --loop dev --iterations 1 --model claude-sonnet-4-6 --effort high
  agent-runner/bin/run-agent-loop.sh --assistant claude --loop dev --iterations 1 --backend host --proxy http://127.0.0.1:3128
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
    --qa-base-url)
      QA_BASE_URL=${2:?missing value for --qa-base-url}
      shift 2
      ;;
    --backend)
      BACKEND=${2:?missing value for --backend}
      shift 2
      ;;
    --proxy)
      PROXY_URL=${2:?missing value for --proxy}
      shift 2
      ;;
    --image)
      AGENT_IMAGE=${2:?missing value for --image}
      shift 2
      ;;
    --workspace)
      WORKSPACE_PATH=${2:?missing value for --workspace}
      shift 2
      ;;
    --git-dir)
      GIT_DIR_PATH=${2:?missing value for --git-dir}
      shift 2
      ;;
    --state-namespace)
      STATE_NAMESPACE=${2:?missing value for --state-namespace}
      shift 2
      ;;
    --bash-history-volume)
      BASH_HISTORY_VOLUME=${2:?missing value for --bash-history-volume}
      shift 2
      ;;
    --codex-config-volume)
      CODEX_CONFIG_VOLUME=${2:?missing value for --codex-config-volume}
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

# Per-repo config seam (AGENT_IMAGE default, etc.). Env/--image still win because
# config.sh uses ${AGENT_IMAGE:-...}. See .agent/config.sh.
if [ -f "$WORKSPACE_PATH/.agent/config.sh" ]; then
  # shellcheck disable=SC1091
  . "$WORKSPACE_PATH/.agent/config.sh"
fi
AGENT_IMAGE="${AGENT_IMAGE:-room-planner-claude}"

case "$ASSISTANT" in
  claude|codex) ;;
  *)
    echo "ERROR: Unsupported assistant: $ASSISTANT"
    exit 1
    ;;
esac

case "$BACKEND" in
  docker|host) ;;
  *)
    echo "ERROR: Unsupported backend: $BACKEND (use docker or host)"
    exit 1
    ;;
esac

if [ -z "$ITERATIONS" ]; then
  case "$LOOP_KIND" in
    dev) ITERATIONS=40 ;;
    qa) ITERATIONS=20 ;;
    *)
      echo "ERROR: Unsupported loop kind: $LOOP_KIND"
      exit 1
      ;;
  esac
fi

if [ "$LOOP_KIND" = "qa" ] && [ -z "$QA_BASE_URL" ]; then
  INTERNAL_QA_BASE_URL="http://127.0.0.1:4173"
fi

# ── host backend ──────────────────────────────────────────────────────────────
# Docker-free: run the assistant directly on the host, in the workspace, routed
# through the host egress proxy. The hard network guarantee is the host's
# root-owned nftables drop (provisioned out-of-band); this just points
# proxy-aware tools at the allowlist. See docs/AGENT_DEV_SYSTEM.md §6.
run_host_backend() {
  cd "$WORKSPACE_PATH"

  if [ -n "$PROXY_URL" ]; then
    export HTTPS_PROXY="$PROXY_URL" HTTP_PROXY="$PROXY_URL"
    export https_proxy="$PROXY_URL" http_proxy="$PROXY_URL"
    NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,::1}"
    export NO_PROXY no_proxy="$NO_PROXY"
    echo "host backend: egress via proxy $PROXY_URL"
  else
    echo "WARNING: host backend without a proxy (--proxy / AGENT_HTTPS_PROXY)." >&2
    echo "         This runner is not allowlisting egress; only safe if the host" >&2
    echo "         enforces nftables egress rules itself, or on a trusted machine." >&2
  fi

  echo "Running workspace setup (${HOOK_SETUP:-.agent/setup.sh})..."
  WORKSPACE="$WORKSPACE_PATH" bash "$WORKSPACE_PATH/${HOOK_SETUP:-.agent/setup.sh}"

  local preview_abs="$WORKSPACE_PATH/${HOOK_PREVIEW:-.agent/hooks/qa-preview.sh}"
  if [ -n "$INTERNAL_QA_BASE_URL" ]; then
    echo "Starting managed preview for QA at $INTERNAL_QA_BASE_URL ..."
    WORKSPACE="$WORKSPACE_PATH" bash "$preview_abs" stop >/dev/null 2>&1 || true
    playwright-cli close-all >/dev/null 2>&1 || true
    pnpm build
    WORKSPACE="$WORKSPACE_PATH" bash "$preview_abs" start
    export QA_BASE_URL="$INTERNAL_QA_BASE_URL" AUDIT_BASE_URL="$INTERNAL_QA_BASE_URL"
    trap "WORKSPACE='$WORKSPACE_PATH' bash '$preview_abs' stop >/dev/null 2>&1 || true; playwright-cli close-all >/dev/null 2>&1 || true" EXIT INT TERM
  elif [ -n "$QA_BASE_URL" ]; then
    export QA_BASE_URL
    if [ "$LOOP_KIND" = "qa" ]; then
      export AUDIT_BASE_URL="$QA_BASE_URL"
    fi
  fi

  local loop_args=(--assistant "$ASSISTANT" --loop "$LOOP_KIND" --iterations "$ITERATIONS")
  if [ -n "$MODEL" ]; then
    loop_args+=(--model "$MODEL")
  fi
  if [ -n "$EFFORT" ]; then
    loop_args+=(--effort "$EFFORT")
  fi

  WORKSPACE="$WORKSPACE_PATH" bash "$RUNNER_DIR/bin/agent-loop.sh" "${loop_args[@]}"
}

if [ "$BACKEND" = "host" ]; then
  run_host_backend
  exit $?
fi

workspace_basename=$(basename "$WORKSPACE_PATH")
default_namespace=$(printf '%s' "$workspace_basename" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')
default_namespace=${default_namespace#-}
default_namespace=${default_namespace%-}
default_namespace=${default_namespace:-room-planner-agent}

STATE_NAMESPACE=${STATE_NAMESPACE:-$default_namespace}
BASH_HISTORY_VOLUME=${BASH_HISTORY_VOLUME:-"${STATE_NAMESPACE}-bashhistory"}
CODEX_CONFIG_VOLUME=${CODEX_CONFIG_VOLUME:-"${STATE_NAMESPACE}-codex-config"}

if [ -z "$GIT_DIR_PATH" ] && [ -e "$WORKSPACE_PATH/.git" ]; then
  if GIT_DIR_PATH=$(git -C "$WORKSPACE_PATH" rev-parse --git-dir 2>/dev/null); then
    :
  else
    GIT_DIR_PATH=""
  fi
fi

if [ -n "$GIT_DIR_PATH" ]; then
  case "$GIT_DIR_PATH" in
    /*) ;;
    *) GIT_DIR_PATH=$(cd "$WORKSPACE_PATH" && cd "$GIT_DIR_PATH" && pwd) ;;
  esac

  if GIT_COMMON_DIR_PATH=$(git -C "$WORKSPACE_PATH" rev-parse --git-common-dir 2>/dev/null); then
    case "$GIT_COMMON_DIR_PATH" in
      /*) ;;
      *) GIT_COMMON_DIR_PATH=$(cd "$WORKSPACE_PATH" && cd "$GIT_COMMON_DIR_PATH" && pwd) ;;
    esac
  else
    GIT_COMMON_DIR_PATH=""
  fi
fi

SEED_DIR=""
cleanup() {
  if [ -n "$SEED_DIR" ] && [ -d "$SEED_DIR" ]; then
    rm -rf "$SEED_DIR"
  fi
}
trap cleanup EXIT INT TERM

docker_args=(
  --rm -it --init
  --user root
  --cap-drop=ALL
  --cap-add=CHOWN
  --cap-add=NET_ADMIN
  --cap-add=NET_RAW
  --cap-add=SETGID
  --cap-add=SETUID
  --pids-limit=512
  --add-host=host.docker.internal:host-gateway
  -e COREPACK_ENABLE_AUTO_PIN=0
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
  -v "$WORKSPACE_PATH":/workspace
  -v "$BASH_HISTORY_VOLUME":/commandhistory
)

if [ -n "$GIT_DIR_PATH" ]; then
  docker_args+=(-v "$GIT_DIR_PATH":"$GIT_DIR_PATH")
fi

if [ -n "$GIT_COMMON_DIR_PATH" ] && [ "$GIT_COMMON_DIR_PATH" != "$GIT_DIR_PATH" ]; then
  docker_args+=(-v "$GIT_COMMON_DIR_PATH":"$GIT_COMMON_DIR_PATH")
fi

if [ "$ASSISTANT" = "codex" ]; then
  SEED_DIR=$(mktemp -d)

  if [ -f "$HOME/.codex/auth.json" ]; then
    cp "$HOME/.codex/auth.json" "$SEED_DIR/auth.json"
  fi

  if [ -f "$HOME/.codex/config.toml" ]; then
    cp "$HOME/.codex/config.toml" "$SEED_DIR/config.toml"
  fi

  docker_args+=(
    -e OPENAI_API_KEY
    -v "$CODEX_CONFIG_VOLUME":/home/node/.codex
    -v "$SEED_DIR":/tmp/host-codex:ro
  )
else
  docker_args+=(-v "$HOME/.claude":/home/node/.claude)

  if [ -f "$HOME/.claude.json" ]; then
    docker_args+=(-v "$HOME/.claude.json":/tmp/host-claude.json:ro)
  fi
fi

if [ -n "$QA_BASE_URL" ]; then
  docker_args+=(-e QA_BASE_URL="$QA_BASE_URL")
  # The Explorer (qa) also audits the 3D view against the same URL
  if [ "$LOOP_KIND" = "qa" ]; then
    docker_args+=(-e AUDIT_BASE_URL="$QA_BASE_URL")
  fi
fi

inner_args=(
  bash agent-runner/bin/agent-loop.sh
  --assistant "$ASSISTANT"
  --loop "$LOOP_KIND"
  --iterations "$ITERATIONS"
)

if [ -n "$MODEL" ]; then
  inner_args+=(--model "$MODEL")
fi

if [ -n "$EFFORT" ]; then
  inner_args+=(--effort "$EFFORT")
fi

printf -v inner_cmd '%q ' "${inner_args[@]}"
printf -v user_cmd '%q ' bash -lc "$inner_cmd"

container_cmd="rc=1; "
container_cmd+="/usr/local/bin/init-firewall.sh && "
container_cmd+="mkdir -p /home/node/.codex /commandhistory && "
container_cmd+="chown -R node:node /home/node/.codex /commandhistory 2>/dev/null || true && "
container_cmd+="export PATH=/usr/local/share/pnpm-global:\$PATH && "
container_cmd+="export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright && "

container_cmd+="su node -s /bin/bash -lc 'export PATH=/usr/local/share/pnpm-global:\$PATH && export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright && cd /workspace && bash ${HOOK_SETUP:-.agent/setup.sh}' && "

if [ -n "$INTERNAL_QA_BASE_URL" ]; then
  container_cmd+="su node -s /bin/bash -lc 'export PATH=/usr/local/share/pnpm-global:\$PATH && export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright && export QA_BASE_URL=$INTERNAL_QA_BASE_URL && cd /workspace && bash .agent/hooks/qa-preview.sh stop >/dev/null 2>&1 || true; playwright-cli close-all >/dev/null 2>&1 || true; pnpm build; bash .agent/hooks/qa-preview.sh start' && "
  container_cmd+="export QA_BASE_URL=$INTERNAL_QA_BASE_URL && "
  container_cmd+="export AUDIT_BASE_URL=$INTERNAL_QA_BASE_URL && "
fi

agent_env="export PATH=/usr/local/share/pnpm-global:\$PATH && export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright"
if [ -n "$INTERNAL_QA_BASE_URL" ]; then
  agent_env+=" && export QA_BASE_URL=$INTERNAL_QA_BASE_URL && export AUDIT_BASE_URL=$INTERNAL_QA_BASE_URL"
fi
container_cmd+="{ rc=0; su node -s /bin/bash -lc \"$agent_env && cd /workspace && $inner_cmd\" || rc=\$?; }; "

if [ -n "$INTERNAL_QA_BASE_URL" ]; then
  container_cmd+="su node -s /bin/bash -lc 'export PATH=/usr/local/share/pnpm-global:\$PATH && export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright && cd /workspace && bash .agent/hooks/qa-preview.sh stop >/dev/null 2>&1 || true; playwright-cli close-all >/dev/null 2>&1 || true' || true; "
fi

container_cmd+="exit \$rc"

docker run "${docker_args[@]}" "$AGENT_IMAGE" bash -lc "$container_cmd"
