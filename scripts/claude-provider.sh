#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: scripts/claude-provider.sh <profile> [harness/claude arguments...]

Profiles:
  ark-glm          Volcano Ark / glm-5.3-flash
  ark-kimi         Volcano Ark / kimi-k2.7-code
  ark-kimi3        Volcano Ark / kimi-k3
  deepseek-flash   DeepSeek official / deepseek-v4-flash
  deepseek-pro     DeepSeek official / deepseek-v4-pro

Keys are read from environment variables first, then from:
  ~/.config/agent-harness/claude-providers.env
EOF
}

profile="${1:-}"
if [[ -z "$profile" ]]; then
  usage
  exit 2
fi
shift

provider_file="${AGENT_HARNESS_PROVIDER_FILE:-$HOME/.config/agent-harness/claude-providers.env}"
if [[ -f "$provider_file" ]]; then
  # This is a user-owned, mode-600 shell environment file.
  set -a
  # shellcheck disable=SC1090
  source "$provider_file"
  set +a
fi

case "$profile" in
  ark-glm)
    provider_name="Volcano Ark"
    base_url="https://ark.cn-beijing.volces.com/api/coding/v3"
    model="glm-5.3-flash"
    api_key="${ARK_API_KEY:-}"
    key_name="ARK_API_KEY"
    ;;
  ark-kimi)
    provider_name="Volcano Ark"
    base_url="https://ark.cn-beijing.volces.com/api/coding/v3"
    model="kimi-k2.7-code"
    api_key="${ARK_API_KEY:-}"
    key_name="ARK_API_KEY"
    ;;
  ark-kimi3)
    provider_name="Volcano Ark"
    base_url="https://ark.cn-beijing.volces.com/api/coding/v3"
    model="kimi-k3"
    api_key="${ARK_API_KEY:-}"
    key_name="ARK_API_KEY"
    ;;
  deepseek-flash)
    provider_name="DeepSeek official"
    base_url="https://api.deepseek.com/anthropic"
    model="deepseek-v4-flash"
    api_key="${DEEPSEEK_API_KEY:-}"
    key_name="DEEPSEEK_API_KEY"
    ;;
  deepseek-pro)
    provider_name="DeepSeek official"
    base_url="https://api.deepseek.com/anthropic"
    model="deepseek-v4-pro"
    api_key="${DEEPSEEK_API_KEY:-}"
    key_name="DEEPSEEK_API_KEY"
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    printf 'Unknown provider profile: %s\n\n' "$profile" >&2
    usage
    exit 2
    ;;
esac

if [[ -z "$api_key" ]]; then
  printf '%s is empty. Fill it in %s or export it in this shell.\n' "$key_name" "$provider_file" >&2
  exit 2
fi

# Remove variables used by the retired local gateway before launching Claude.
unset ANTHROPIC_API_BASE_URL
unset ANTHROPIC_API_KEY
unset ANTHROPIC_IDENTITY_TOKEN_FILE
unset ANTHROPIC_ORGANIZATION_ID
unset ANTHROPIC_FEDERATION_RULE_ID
unset CLAUDE_AGENT_API_BASE_URL
unset CCR_CLAUDE_CODE_MODEL
unset CODEXL_CLAUDE_CODE_MODEL

export ANTHROPIC_BASE_URL="$base_url"
export ANTHROPIC_AUTH_TOKEN="$api_key"
export ANTHROPIC_MODEL="$model"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$model"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$model"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$model"

printf 'Starting Agent Harness with %s (%s).\n' "$provider_name" "$model" >&2
if [[ "${AGENT_HARNESS_DRY_RUN:-}" == "1" ]]; then
  printf 'npm run dev -- controlled-run --model %s' "$model"
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n'
  exit 0
fi

exec npm run dev -- controlled-run --model "$model" "$@"
