#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
bin_dir="${AGENT_HARNESS_BIN_DIR:-$HOME/.local/bin}"

mkdir -p "$bin_dir"

install_shortcut() {
  local name="$1"
  local profile="$2"
  local target="$bin_dir/$name"

  if [[ -e "$target" ]] && ! grep -q 'agent-harness claude provider shortcut' "$target" 2>/dev/null; then
    printf 'Refusing to overwrite existing file: %s\n' "$target" >&2
    exit 1
  fi

  cat > "$target" <<EOF
#!/usr/bin/env bash
# agent-harness claude provider shortcut
set -euo pipefail
cd "$repo_root"
exec bash scripts/claude-provider.sh "$profile" "\$@"
EOF
  chmod 700 "$target"
}

install_shortcut glm ark-glm
install_shortcut kimi ark-kimi
install_shortcut ds deepseek-flash
install_shortcut dsp deepseek-pro

case ":$PATH:" in
  *":$bin_dir:"*)
    ;;
  *)
    printf 'Shortcuts installed in %s, but this directory is not currently in PATH.\n' "$bin_dir" >&2
    printf 'Add this line to ~/.bashrc, then reopen Bash or run source ~/.bashrc:\n' >&2
    printf 'export PATH="$HOME/.local/bin:$PATH"\n' >&2
    ;;
esac

printf 'Installed Claude provider shortcuts: glm, kimi, ds, dsp\n'
