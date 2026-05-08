#!/usr/bin/env bash
# =============================================================================
# vibeOS — one-line installer
# =============================================================================
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/penrokib/vibeos/main/install.sh | bash
#
# What it does:
#   1. Detects OS (macOS / Linux / Windows-under-WSL)
#   2. Detects arch (arm64 / x64)
#   3. Checks hard prerequisites (claude-code CLI)
#   4. Optionally checks soft prerequisites (whisper-cpp)
#   5. Downloads the right artifact from GitHub Releases
#   6. Optionally verifies SHA-256 against SHASUMS.txt
#   7. Installs to /Applications (mac) or ~/Applications (linux)
#
# Hardwalls:
#   - Only writes to ~/Downloads/ (temp) and /Applications or ~/Applications
#   - Never auto-sudo — drag-to-Applications doesn't need it
#   - Fails fast on 4xx/5xx (curl -f)
#   - Never executes downloaded content directly
# =============================================================================

set -euo pipefail

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { printf "${CYAN}[vibeOS]${RESET} %s\n" "$*"; }
success() { printf "${GREEN}[vibeOS]${RESET} %s\n" "$*"; }
warn()    { printf "${YELLOW}[vibeOS] WARNING:${RESET} %s\n" "$*"; }
error()   { printf "${RED}[vibeOS] ERROR:${RESET} %s\n" "$*" >&2; }
die()     { error "$*"; exit 1; }

# ── constants ─────────────────────────────────────────────────────────────────
REPO="penrokib/vibeos"
RELEASES_URL="https://github.com/${REPO}/releases/latest/download"
SHASUMS_FILE="SHASUMS.txt"

# ── OS detection ──────────────────────────────────────────────────────────────
detect_os() {
  local os
  os="$(uname -s 2>/dev/null || true)"
  case "$os" in
    Darwin) echo "macos" ;;
    Linux)
      # WSL detection
      if grep -qi microsoft /proc/version 2>/dev/null; then
        echo "wsl"
      else
        echo "linux"
      fi
      ;;
    CYGWIN*|MINGW*|MSYS*)
      echo "windows"
      ;;
    *)
      echo "unknown"
      ;;
  esac
}

# ── arch detection ────────────────────────────────────────────────────────────
detect_arch() {
  local machine
  machine="$(uname -m 2>/dev/null || true)"
  case "$machine" in
    arm64|aarch64) echo "arm64" ;;
    x86_64|amd64)  echo "x64"   ;;
    *) echo "unknown" ;;
  esac
}

# ── prerequisite checks ───────────────────────────────────────────────────────
check_prerequisites() {
  local os="$1"

  # Hard requirement: claude-code CLI
  if ! command -v claude &>/dev/null; then
    error "claude-code CLI is not installed. vibeOS requires it to run its AI engine."
    echo ""
    echo "  Install it first:"
    if [[ "$os" == "macos" ]]; then
      echo "    brew install anthropic/claude/claude-code"
      echo "  or: npm install -g @anthropic-ai/claude-code"
    else
      echo "    npm install -g @anthropic-ai/claude-code"
    fi
    echo ""
    echo "  Then re-run this installer."
    exit 1
  fi
  info "claude-code CLI found: $(command -v claude)"

  # Soft requirement: whisper-cpp (recommended, not required)
  if ! command -v whisper-cpp &>/dev/null && ! command -v whisper &>/dev/null; then
    warn "whisper-cpp not found. Voice-to-text features will be unavailable."
    warn "Install it later: brew install whisper-cpp  (mac) / see whisper.cpp on GitHub (linux)"
  else
    info "whisper-cpp found (voice features enabled)"
  fi
}

# ── SHA-256 verification ───────────────────────────────────────────────────────
verify_sha256() {
  local file="$1"
  local expected_sha="$2"

  local actual_sha
  if command -v sha256sum &>/dev/null; then
    actual_sha="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum &>/dev/null; then
    actual_sha="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    warn "No sha256sum or shasum found — skipping checksum verification."
    return 0
  fi

  if [[ "$actual_sha" != "$expected_sha" ]]; then
    die "SHA-256 mismatch for $(basename "$file")!
  Expected: $expected_sha
  Actual:   $actual_sha
  The download may be corrupted or tampered with. Aborting."
  fi

  info "SHA-256 verified OK: $(basename "$file")"
}

# ── download with integrity check ─────────────────────────────────────────────
download_artifact() {
  local url="$1"
  local dest="$2"
  local filename
  filename="$(basename "$dest")"

  info "Downloading ${filename} …"

  # Fail fast on 4xx/5xx (curl -f), follow redirects (-L), show progress (-#)
  if ! curl -fsSL --retry 3 --retry-delay 2 --output "$dest" "$url"; then
    echo ""
    error "Download failed: ${url}"
    error "This usually means no release has been published yet."
    echo ""
    echo "  Check: https://github.com/${REPO}/releases"
    echo "  If no release exists, wait for the first v1.0.0 release tag."
    exit 1
  fi

  success "Downloaded $(du -sh "$dest" | awk '{print $1}') → ${dest}"
}

# ── optional SHASUMS verification ─────────────────────────────────────────────
try_verify_shasums() {
  local artifact_path="$1"
  local shasums_url="${RELEASES_URL}/${SHASUMS_FILE}"
  local shasums_path
  shasums_path="$(dirname "$artifact_path")/${SHASUMS_FILE}"
  local filename
  filename="$(basename "$artifact_path")"

  info "Attempting to fetch ${SHASUMS_FILE} for integrity verification …"

  # If SHASUMS.txt download fails (404 = pre-release, no file yet), skip silently
  if ! curl -fsSL --retry 2 --output "$shasums_path" "$shasums_url" 2>/dev/null; then
    warn "SHASUMS.txt not found at release — skipping checksum verification."
    return 0
  fi

  # Find the SHA for our specific artifact
  local expected_sha
  expected_sha="$(grep " ${filename}$" "$shasums_path" | awk '{print $1}' || true)"

  if [[ -z "$expected_sha" ]]; then
    warn "No entry for ${filename} in SHASUMS.txt — skipping checksum verification."
    rm -f "$shasums_path"
    return 0
  fi

  verify_sha256 "$artifact_path" "$expected_sha"
  rm -f "$shasums_path"
}

# ── macOS install ─────────────────────────────────────────────────────────────
install_macos() {
  local arch="$1"
  local artifact_name="rokibrain-${arch}.dmg"
  local download_url="${RELEASES_URL}/${artifact_name}"
  local download_dir="${HOME}/Downloads"
  local dmg_path="${download_dir}/${artifact_name}"
  local app_name="rokibrain.app"
  local install_dir="/Applications"
  local mount_point
  mount_point="$(mktemp -d /tmp/vibeos-dmg-XXXXXX)"

  mkdir -p "$download_dir"
  download_artifact "$download_url" "$dmg_path"
  try_verify_shasums "$dmg_path"

  info "Mounting DMG …"
  if ! hdiutil attach -quiet -nobrowse -mountpoint "$mount_point" "$dmg_path"; then
    warn "hdiutil failed. Attempting manual install path."
    warn "Please open ${dmg_path} in Finder and drag ${app_name} to /Applications."
    return 0
  fi

  local app_src="${mount_point}/${app_name}"
  if [[ ! -d "$app_src" ]]; then
    hdiutil detach -quiet "$mount_point" 2>/dev/null || true
    warn "Could not find ${app_name} inside the DMG."
    warn "Please open ${dmg_path} in Finder and drag it to /Applications manually."
    return 0
  fi

  local app_dest="${install_dir}/${app_name}"
  info "Copying ${app_name} to ${install_dir} …"

  # Remove old install if present (no sudo needed when user owns /Applications/VibeOS.app)
  if [[ -d "$app_dest" ]]; then
    info "Removing existing installation at ${app_dest} …"
    rm -rf "$app_dest" || {
      warn "Could not remove ${app_dest}. You may need to remove it manually."
      warn "Try: rm -rf '${app_dest}' then re-run the installer."
      hdiutil detach -quiet "$mount_point" 2>/dev/null || true
      exit 1
    }
  fi

  cp -R "$app_src" "$app_dest" || {
    error "Failed to copy ${app_name} to ${install_dir}."
    error "This installer deliberately avoids sudo."
    error "If /Applications is locked, drag from ${dmg_path} to /Applications in Finder."
    hdiutil detach -quiet "$mount_point" 2>/dev/null || true
    exit 1
  }

  hdiutil detach -quiet "$mount_point" 2>/dev/null || true
  rm -rf "$mount_point"
  rm -f "$dmg_path"

  # Remove quarantine attribute so Gatekeeper doesn't block first launch
  if xattr -d com.apple.quarantine "$app_dest" &>/dev/null; then
    info "Removed quarantine attribute (so Gatekeeper won't block launch)"
  fi

  echo ""
  success "vibeOS installed to ${app_dest}"
  success "Launch with:  open -a rokibrain"
  echo ""
  info "First launch shows the setup wizard — connect your Claude Code subscription"
  info "and pair your first comms account."
}

# ── Linux install ─────────────────────────────────────────────────────────────
install_linux() {
  local arch="$1"
  local artifact_name="rokibrain-${arch}.AppImage"
  local download_url="${RELEASES_URL}/${artifact_name}"
  local install_dir="${HOME}/Applications"
  local dest="${install_dir}/${artifact_name}"
  local symlink="${install_dir}/vibeos"

  mkdir -p "$install_dir"
  download_artifact "$download_url" "$dest"
  try_verify_shasums "$dest"

  chmod +x "$dest"

  # Create a stable symlink so PATH entry doesn't need to change on update
  ln -sf "$dest" "$symlink"

  echo ""
  success "vibeOS installed to ${dest}"
  success "Symlink: ${symlink}"
  echo ""
  info "Add to PATH (add this to ~/.bashrc or ~/.zshrc):"
  echo "    export PATH=\"\${HOME}/Applications:\${PATH}\""
  echo ""
  info "Then launch with:  vibeos"
  info "Or run directly:  ${dest}"
  echo ""
  info "First launch shows the setup wizard — connect your Claude Code subscription"
  info "and pair your first comms account."
}

# ── Windows / WSL warning ─────────────────────────────────────────────────────
install_windows() {
  echo ""
  warn "Windows (or WSL) detected."
  echo ""
  echo "  vibeOS for Windows ships as an NSIS installer (.exe)."
  echo "  Please download and run it from:"
  echo ""
  echo "    https://github.com/${REPO}/releases/latest"
  echo ""
  echo "  Look for a file named: rokibrain-x64.exe"
  echo ""
  echo "  Note: The Windows build is unsigned in early releases (SmartScreen may"
  echo "  warn you). Click 'More info → Run anyway' to proceed."
  echo ""
  exit 0
}

# ── main ──────────────────────────────────────────────────────────────────────
main() {
  echo ""
  printf "${BOLD}vibeOS Installer${RESET}\n"
  printf "────────────────────────────────────────────────\n"
  echo ""

  local os
  os="$(detect_os)"
  local arch
  arch="$(detect_arch)"

  info "Detected OS:   ${os}"
  info "Detected arch: ${arch}"
  echo ""

  # Windows / WSL — redirect to manual download
  if [[ "$os" == "windows" || "$os" == "wsl" ]]; then
    install_windows
  fi

  # Unknown OS
  if [[ "$os" == "unknown" ]]; then
    die "Unsupported OS. Please download the right artifact from: https://github.com/${REPO}/releases/latest"
  fi

  # Unknown arch
  if [[ "$arch" == "unknown" ]]; then
    die "Unsupported architecture: $(uname -m). Only arm64 and x64 are supported."
  fi

  # Check prerequisites
  check_prerequisites "$os"
  echo ""

  # Platform-specific install
  case "$os" in
    macos) install_macos "$arch" ;;
    linux) install_linux "$arch" ;;
  esac
}

main "$@"
