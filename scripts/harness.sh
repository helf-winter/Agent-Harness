#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
working_directory="${AGENT_HARNESS_WORKING_DIRECTORY:-$(pwd -P)}"
provider_file="${AGENT_HARNESS_ROUTER_FILE:-$HOME/.config/agent-harness/harness-router.env}"

if [[ -f "$provider_file" ]]; then
  # User-owned shell environment file. It may contain a CCR client key.
  set -a
  # shellcheck disable=SC1090
  source "$provider_file"
  set +a
fi

start_ccr="${AGENT_HARNESS_START_CCR:-1}"
ccr_profile="${AGENT_HARNESS_CCR_PROFILE:-default-claude-code}"

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
unset ANTHROPIC_MODEL
unset ANTHROPIC_SMALL_FAST_MODEL
unset ANTHROPIC_DEFAULT_MODEL
unset ANTHROPIC_DEFAULT_FABLE_MODEL
unset ANTHROPIC_DEFAULT_OPUS_MODEL
unset ANTHROPIC_DEFAULT_SONNET_MODEL
unset ANTHROPIC_DEFAULT_HAIKU_MODEL
unset CLAUDE_AGENT_API_BASE_URL
unset CCR_CLAUDE_CODE_MODEL
unset CODEXL_CLAUDE_CODE_MODEL
unset CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY

export AGENT_HARNESS_CCR_PROFILE="$ccr_profile"
export AGENT_HARNESS_WORKING_DIRECTORY="$working_directory"
export CLAUDE_EXECUTABLE="$repo_root/scripts/ccr-claude.sh"

printf 'Starting Agent Harness through Claude Code Router profile %s.\n' "$ccr_profile" >&2
printf 'Use Claude Code /model to switch among Harness-approved CCR models.\n' >&2

cd "$repo_root"

if [[ "${AGENT_HARNESS_DRY_RUN:-}" == "1" ]]; then
  printf 'CLAUDE_EXECUTABLE=%s\n' "$CLAUDE_EXECUTABLE"
  printf 'AGENT_HARNESS_WORKING_DIRECTORY=%s\n' "$AGENT_HARNESS_WORKING_DIRECTORY"
  printf 'npm run dev -- agent-run'
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n'
  exit 0
fi

exec npm run dev -- agent-run "$@"
