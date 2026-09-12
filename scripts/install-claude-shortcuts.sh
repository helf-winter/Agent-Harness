#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
bin_dir="${AGENT_HARNESS_BIN_DIR:-$HOME/.local/bin}"

mkdir -p "$bin_dir"

is_managed_shortcut() {
  local target="$1"
  local command_pattern="$2"

  grep -q 'agent-harness claude provider shortcut' "$target" 2>/dev/null ||
    grep -q 'agent-harness ccr shortcut' "$target" 2>/dev/null ||
    grep -q "$command_pattern" "$target" 2>/dev/null
}

install_shortcut() {
  local name="$1"
  local profile="$2"
  local target="$bin_dir/$name"

  if [[ -e "$target" ]] && ! is_managed_shortcut "$target" 'scripts/claude-provider.sh'; then
    printf 'Refusing to overwrite existing file: %s\n' "$target" >&2
    exit 1
  fi

  cat > "$target" <<EOF
#!/usr/bin/env bash
# agent-harness claude provider shortcut
set -euo pipefail
working_directory="\$(pwd -P)"
cd "$repo_root"
export AGENT_HARNESS_WORKING_DIRECTORY="\$working_directory"
exec bash scripts/claude-provider.sh "$profile" "\$@"
EOF
  chmod 700 "$target"
}

install_menu_shortcut() {
  local target="$bin_dir/cc"

  if [[ -e "$target" ]] && ! is_managed_shortcut "$target" 'scripts/claude-provider-menu.sh'; then
    printf 'Refusing to overwrite existing file: %s\n' "$target" >&2
    exit 1
  fi

  cat > "$target" <<EOF
#!/usr/bin/env bash
# agent-harness claude provider shortcut
set -euo pipefail
working_directory="\$(pwd -P)"
cd "$repo_root"
export AGENT_HARNESS_WORKING_DIRECTORY="\$working_directory"
exec bash scripts/claude-provider-menu.sh "\$@"
EOF
  chmod 700 "$target"
}

install_harness_shortcut() {
  local target="$bin_dir/harness"

  if [[ -e "$target" ]] && ! is_managed_shortcut "$target" 'scripts/harness.sh'; then
    printf 'Refusing to overwrite existing file: %s\n' "$target" >&2
    exit 1
  fi

  cat > "$target" <<EOF
#!/usr/bin/env bash
# agent-harness ccr shortcut
set -euo pipefail
working_directory="\$(pwd -P)"
cd "$repo_root"
export AGENT_HARNESS_WORKING_DIRECTORY="\$working_directory"
exec bash scripts/harness.sh "\$@"
EOF
  chmod 700 "$target"
}

install_harness_shortcut
install_menu_shortcut
install_shortcut glm ark-glm
install_shortcut kimi ark-kimi
install_shortcut kimi3 ark-kimi3
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

printf 'Installed Agent Harness shortcuts: harness, cc, glm, kimi, kimi3, ds, dsp\n'
