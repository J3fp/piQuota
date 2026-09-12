#!/usr/bin/env bash
#
# install.sh — install pi-quota into user space.
#
# No sudo required. Standalone project: does not modify, import or invoke
# shuvquota, and never writes to any credential file.
#
# What it does:
#   1. validates prerequisites: Node.js >= 20, Pi Coding Agent, Gentle AI
#   2. detects operating system and platform nuances
#   3. copies src/, bin/ and package.json to ~/.local/share/pi-quota
#   4. symlinks ~/.local/bin/piquota
#   5. installs extensions/quota-panel.ts into ~/.pi/agent/extensions
#   6. cleans up obsolete shims if upgrading from previous versions

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd 2>/dev/null || pwd)"

# Detect if running from a pipe/curl (no local repo files present)
if [[ ! -f "${HERE:-}/package.json" ]]; then
  echo "Downloading pi-quota from GitHub..."
  TMP_DIR="$(mktemp -d /tmp/pi-quota-install-XXXXXX)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 https://github.com/J3fp/piQuota.git "$TMP_DIR" >/dev/null 2>&1
  else
    curl -fsSL https://github.com/J3fp/piQuota/archive/refs/heads/main.tar.gz | tar -xz -C "$TMP_DIR" --strip-components=1
  fi
  exec bash "$TMP_DIR/install.sh" "$@"
fi

PREFIX="${PI_QUOTA_PREFIX:-$HOME/.local/share/pi-quota}"
BIN_DIR="${PI_QUOTA_BIN_DIR:-$HOME/.local/bin}"
EXT_DIR="${PI_QUOTA_EXT_DIR:-$HOME/.pi/agent/extensions}"
MODE="copy"

for arg in "$@"; do
  case "$arg" in
    --link) MODE="link" ;;
    --copy) MODE="copy" ;;
    --uninstall) MODE="uninstall" ;;
    -h|--help)
      cat <<'USAGE'
Usage: ./install.sh [--copy|--link|--uninstall]

  --copy       Copy the project into ~/.local/share/pi-quota (default)
  --link       Symlink the project instead, for development
  --uninstall  Remove the installed tree, the piquota shim and the Pi extension

Environment overrides: PI_QUOTA_PREFIX, PI_QUOTA_BIN_DIR, PI_QUOTA_EXT_DIR
USAGE
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

log()  { printf '  %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
fail() { printf '\033[31m✗\033[0m %s\n' "$*"; exit 1; }

# --- Uninstallation ---
if [[ "$MODE" == "uninstall" ]]; then
  echo "Uninstalling pi-quota..."
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now pi-quota-moshi.service >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/pi-quota-moshi.service"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  rm -f "$BIN_DIR/piquota" "$BIN_DIR/shuvquota"
  rm -f "$EXT_DIR/quota-panel.ts"
  rm -rf "$PREFIX"
  ok "removed the tree, the shims, the Pi extension and background services"
  warn "credentials and settings were left untouched"
  exit 0
fi

echo "=========================================="
echo "Installing pi-quota ($MODE mode)"
echo "=========================================="

# --- 1. Validate Node.js version ---
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is not installed. Node.js >= 20.0.0 is required."
fi

NODE_VERSION="$(node -v | sed 's/^v//')"
NODE_MAJOR="$(echo "$NODE_VERSION" | cut -d. -f1)"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  fail "Node.js v$NODE_VERSION found. Node.js >= 20.0.0 is required (native node:sqlite & fetch support)."
fi
ok "Node.js v$NODE_VERSION (>= 20.0.0)"

# --- 2. Validate Pi Coding Agent ---
PI_FOUND=false
if command -v pi >/dev/null 2>&1; then
  PI_VERSION="$(pi --version 2>/dev/null || echo "detected")"
  ok "Pi Coding Agent found: $PI_VERSION ($(command -v pi))"
  PI_FOUND=true
elif [[ -d "$HOME/.pi/agent" ]]; then
  ok "Pi home directory found at $HOME/.pi/agent"
  PI_FOUND=true
else
  warn "Pi Coding Agent not found on PATH or at ~/.pi/agent."
  warn "Install Pi Coding Agent first: https://github.com/earendil-works/pi"
fi

# --- 3. Validate Gentle AI harness ---
GENTLE_FOUND=false
if command -v gentle-ai >/dev/null 2>&1; then
  GENTLE_VERSION="$(gentle-ai --version 2>/dev/null || echo "detected")"
  ok "Gentle AI harness found: $GENTLE_VERSION ($(command -v gentle-ai))"
  GENTLE_FOUND=true
elif [[ -f "$HOME/.pi/agent/settings.json" ]] && grep -q "gentle-pi" "$HOME/.pi/agent/settings.json" 2>/dev/null; then
  ok "Gentle AI (gentle-pi package) configured in ~/.pi/agent/settings.json"
  GENTLE_FOUND=true
elif [[ -d "$HOME/.pi/agent/gentle-ai" || -d "$HOME/.pi/agent/npm/node_modules/gentle-pi" ]]; then
  ok "Gentle AI harness directory found in ~/.pi/agent/"
  GENTLE_FOUND=true
fi

if [[ "$GENTLE_FOUND" != "true" ]]; then
  warn "Gentle AI (gentle-pi) was not detected in your Pi setup."
  warn "To install Gentle AI harness, run:"
  warn "  pi install npm:gentle-pi"
  warn "or see: https://github.com/Gentleman-Programming/gentle-pi"
fi

# --- 4. Detect Platform & OS Nuances ---
OS_TYPE="$(uname -s)"
case "$OS_TYPE" in
  Linux*)
    if grep -qi "microsoft" /proc/version 2>/dev/null; then
      ok "Platform: WSL2 (Windows Subsystem for Linux)"
      log "WSL notice: Windows Firefox cookies are auto-discovered at /mnt/c/Users/..."
      log "            Windows Chrome/Edge use DPAPI encryption; use Firefox for OpenCode Go."
    else
      ok "Platform: Native Linux"
      log "Linux notice: systemd user service available for background Moshi sync."
    fi
    ;;
  Darwin*)
    ok "Platform: macOS"
    log "macOS notice: Firefox cookies at ~/Library/Application Support/Firefox/"
    log "              Background sync uses launchd or tmux (systemd not used)."
    ;;
  MINGW*|MSYS*|CYGWIN*)
    ok "Platform: Windows (POSIX shell)"
    ;;
  *)
    log "Platform: $OS_TYPE"
    ;;
esac

echo
echo "--- Installing Files ---"
mkdir -p "$BIN_DIR" "$EXT_DIR"

if [[ "$MODE" == "link" ]]; then
  rm -rf "$PREFIX"
  mkdir -p "$(dirname "$PREFIX")"
  ln -sfn "$HERE" "$PREFIX"
  log "linked $PREFIX -> $HERE"
else
  rm -rf "$PREFIX"
  mkdir -p "$PREFIX"
  cp -R "$HERE/src" "$HERE/bin" "$PREFIX/"
  cp "$HERE/package.json" "$PREFIX/"
  log "copied project to $PREFIX"
fi

chmod +x "$PREFIX/bin/piquota.js" 2>/dev/null || true

ln -sfn "$PREFIX/bin/piquota.js" "$BIN_DIR/piquota"
ok "CLI shim installed: $BIN_DIR/piquota"

# Remove legacy shuvquota shadow shim if present
if [[ -L "$BIN_DIR/shuvquota" && "$(readlink -f "$BIN_DIR/shuvquota" 2>/dev/null || true)" == *"pi-quota"* ]]; then
  rm -f "$BIN_DIR/shuvquota"
  warn "cleaned up legacy shuvquota shim; upstream shuvquota is accessible again"
fi

cp "$HERE/extensions/quota-panel.ts" "$EXT_DIR/quota-panel.ts"
ok "Pi TUI extension installed: $EXT_DIR/quota-panel.ts"

echo
echo "--- Diagnostics & Integrations ---"
case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR is on PATH" ;;
  *) warn "$BIN_DIR is not on PATH; add: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# --- Moshi Detection ---
if command -v moshi-hook >/dev/null 2>&1; then
  MOSHI_VER="$(moshi-hook version 2>/dev/null | head -1 || echo "detected")"
  ok "moshi-hook found: $MOSHI_VER"
  if [[ -f "$HOME/.local/state/moshi/secrets.json" ]]; then
    ok "moshi-hook paired with host secret (\`piquota moshi push\` ready)"
  else
    warn "moshi-hook found but not paired yet; run \`moshi-hook pair\` to link your mobile app"
  fi
else
  log "moshi-hook not installed (optional — needed only if syncing to the Moshi mobile app: https://getmoshi.app)"
fi

if compgen -G "/mnt/c/Users/*/AppData/Roaming/Mozilla/Firefox/Profiles/*/cookies.sqlite" >/dev/null 2>&1 \
   || compgen -G "$HOME/.mozilla/firefox/*/cookies.sqlite" >/dev/null 2>&1 \
   || compgen -G "$HOME/Library/Application Support/Firefox/Profiles/*/cookies.sqlite" >/dev/null 2>&1; then
  ok "Firefox profile found (automatic cookie extraction for OpenCode Go supported)"
else
  warn "Firefox profile not detected; use \`piquota auth opencode --paste\` for OpenCode Go"
fi

echo
echo "=========================================="
echo "Installation complete!"
echo "=========================================="
echo "Verify with:"
log "piquota --explain      # verify credential store resolution"
log "piquota                # test the CLI panel"
log "piquota auth status    # check OpenCode Go session discovery"
log "piquota moshi status   # check Moshi integration status"
log "/quota                 # reload or start Pi and run inside TUI"
echo
