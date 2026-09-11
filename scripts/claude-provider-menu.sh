#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

print_menu() {
  cat >&2 <<'EOF'
Select Claude Code provider:

  1) glm   Volcano Ark / glm-5.3-flash
  2) kimi  Volcano Ark / kimi-k2.7-code
  3) kimi3 Volcano Ark / kimi-k3
  4) ds    DeepSeek official / deepseek-v4-flash
  5) dsp   DeepSeek official / deepseek-v4-pro

EOF
}

selection="${1:-}"

if [[ -z "$selection" ]]; then
  print_menu
  read -r -p "Choice [1-5, glm, kimi, kimi3, ds, dsp]: " selection
fi

case "$selection" in
  1|glm|ark-glm|glm-5.3-flash)
    exec bash scripts/claude-provider.sh ark-glm "${@:2}"
    ;;
  2|kimi|ark-kimi|kimi-k2.7-code)
    exec bash scripts/claude-provider.sh ark-kimi "${@:2}"
    ;;
  3|kimi3|k3|ark-kimi3|kimi-k3)
    exec bash scripts/claude-provider.sh ark-kimi3 "${@:2}"
    ;;
  4|ds|deepseek|deepseek-flash|deepseek-v4-flash)
    exec bash scripts/claude-provider.sh deepseek-flash "${@:2}"
    ;;
  5|dsp|deepseek-pro|deepseek-v4-pro)
    exec bash scripts/claude-provider.sh deepseek-pro "${@:2}"
    ;;
  -h|--help|help)
    print_menu
    exit 0
    ;;
  *)
    printf 'Unknown choice: %s\n\n' "$selection" >&2
    print_menu
    exit 2
    ;;
esac
