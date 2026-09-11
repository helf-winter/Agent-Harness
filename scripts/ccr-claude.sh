#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
profile="${AGENT_HARNESS_CCR_PROFILE:-default-claude-code}"
settings_file="${AGENT_HARNESS_CLAUDE_SETTINGS:-$repo_root/config/claude-model-picker.json}"

if ! command -v ccr >/dev/null 2>&1; then
  printf 'Claude Code Router command `ccr` was not found.\n' >&2
  printf 'Install it with: npm install -g @musistudio/claude-code-router\n' >&2
  exit 2
fi

exec ccr "$profile" cli -- --settings "$settings_file" "$@"
