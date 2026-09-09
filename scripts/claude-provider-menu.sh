#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

print_menu() {
  cat >&2 <<'EOF'
Select Claude Code provider:

  1) glm   Volcano Ark / glm-5.3-flash
  2) kimi  Volcano Ark / kimi-k2.7-code
  3) ds    DeepSeek official / deepseek-v4-flash
  4) dsp   DeepSeek official / deepseek-v4-pro

EOF
}

selection="${1:-}"

if [[ -z "$selection" ]]; then
  print_menu
  read -r -p "Choice [1-4, glm, kimi, ds, dsp]: " selection
fi

case "$selection" in
  1|glm|ark-glm|glm-5.3-flash)
    exec bash scripts/claude-provider.sh ark-glm "${@:2}"
    ;;
  2|kimi|ark-kimi|kimi-k2.7-code)
    exec bash scripts/claude-provider.sh ark-kimi "${@:2}"
    ;;
  3|ds|deepseek|deepseek-flash|deepseek-v4-flash)
    exec bash scripts/claude-provider.sh deepseek-flash "${@:2}"
    ;;
  4|dsp|deepseek-pro|deepseek-v4-pro)
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
