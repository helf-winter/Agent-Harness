#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
provider_file="${AGENT_HARNESS_ROUTER_FILE:-$HOME/.config/agent-harness/harness-router.env}"

if [[ -f "$provider_file" ]]; then
  # User-owned shell environment file. It may contain a CCR client key.
  set -a
  # shellcheck disable=SC1090
  source "$provider_file"
  set +a
fi

ccr_base_url="${AGENT_HARNESS_CCR_BASE_URL:-http://127.0.0.1:3456}"
ccr_auth_token="${AGENT_HARNESS_CCR_AUTH_TOKEN:-${CCR_API_KEY:-agent-harness-local-client}}"
start_ccr="${AGENT_HARNESS_START_CCR:-1}"

if [[ "$start_ccr" != "0" && "${AGENT_HARNESS_DRY_RUN:-}" != "1" ]]; then
  if ! command -v ccr >/dev/null 2>&1; then
    printf 'Claude Code Router command `ccr` was not found.\n' >&2
    printf 'Install it with: npm install -g @musistudio/claude-code-router\n' >&2
    exit 2
  fi
  ccr start --host 127.0.0.1 --no-open >/dev/null
fi

unset ANTHROPIC_API_BASE_URL
unset ANTHROPIC_API_KEY
unset ANTHROPIC_IDENTITY_TOKEN_FILE
unset ANTHROPIC_ORGANIZATION_ID
unset ANTHROPIC_FEDERATION_RULE_ID
unset CLAUDE_AGENT_API_BASE_URL
unset CCR_CLAUDE_CODE_MODEL
unset CODEXL_CLAUDE_CODE_MODEL

export ANTHROPIC_BASE_URL="$ccr_base_url"
export ANTHROPIC_AUTH_TOKEN="$ccr_auth_token"
export ANTHROPIC_API_KEY="$ccr_auth_token"

printf 'Starting Agent Harness through Claude Code Router (%s).\n' "$ccr_base_url" >&2
printf 'Use Claude Code /model to switch among models configured in CCR.\n' >&2

cd "$repo_root"

if [[ "${AGENT_HARNESS_DRY_RUN:-}" == "1" ]]; then
  printf 'ANTHROPIC_BASE_URL=%s\n' "$ANTHROPIC_BASE_URL"
  printf 'npm run dev -- controlled-run'
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n'
  exit 0
fi

exec npm run dev -- controlled-run "$@"
