#!/usr/bin/env bash
set -euo pipefail

provider_file="${AGENT_HARNESS_PROVIDER_FILE:-$HOME/.config/agent-harness/claude-providers.env}"
if [[ ! -f "$provider_file" ]]; then
  printf 'Claude provider key file not found: %s\n' "$provider_file" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "$provider_file"
set +a

if [[ -z "${ARK_API_KEY:-}" ]]; then
  printf 'ARK_API_KEY is empty in %s\n' "$provider_file" >&2
  exit 2
fi

printf '%s' "$ARK_API_KEY"
