#!/usr/bin/env bash
# Installs carbon on an Omarchy (Arch + Hyprland) desktop, for the current user.
#
#   scripts/install-omarchy.sh                 install the newest dist/*.AppImage (or dist/linux-unpacked)
#   scripts/install-omarchy.sh --appimage F    install that AppImage
#   scripts/install-omarchy.sh --dir D         install an unpacked build (e.g. dist/linux-unpacked)
#   scripts/install-omarchy.sh --hypr          also source the window rule from hyprland.conf
#   scripts/install-omarchy.sh --uninstall     remove everything this script installed
#   scripts/install-omarchy.sh --dry-run ...   print what would happen, change nothing
#
# What it installs (all idempotent: running it again gives the same result):
#
#   ~/.local/share/carbon/              the app (carbon.AppImage, or app/ for an unpacked build)
#   ~/.local/bin/carbon                 the launcher: focuses the running carbon through
#                                       hyprctl if there is one, starts it otherwise
#   ~/.local/share/applications/carbon.desktop
#   ~/.config/hypr/carbon.conf          the suggested Hyprland window rule (a file of its own;
#                                       hyprland.conf sources it only with --hypr)
#
# Run `npm run dist` first. Environment overrides (used by the tests): XDG_DATA_HOME,
# XDG_CONFIG_HOME, CARBON_BIN_DIR.
set -euo pipefail

MARK='# carbon: installed by scripts/install-omarchy.sh'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
BIN="${CARBON_BIN_DIR:-$HOME/.local/bin}"
APP_DIR="$DATA/carbon"
LAUNCHER="$BIN/carbon"
DESKTOP="$DATA/applications/carbon.desktop"
HYPR_DIR="$CONFIG/hypr"
HYPR_SNIPPET="$HYPR_DIR/carbon.conf"
HYPR_MAIN="$HYPR_DIR/hyprland.conf"
SOURCE_LINE="source = $HYPR_SNIPPET $MARK"

mode=install
appimage=''
unpacked=''
hypr=0
dry=0

die() { echo "install-omarchy: $*" >&2; exit 1; }
say() { echo "  $*"; }
run() { if [ "$dry" = 1 ]; then echo "  would: $*"; else "$@"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) mode=uninstall ;;
    --appimage) [ $# -ge 2 ] || die '--appimage needs a file'; appimage="$2"; shift ;;
    --dir) [ $# -ge 2 ] || die '--dir needs a directory'; unpacked="$2"; shift ;;
    --hypr) hypr=1 ;;
    --dry-run) dry=1 ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

# Writes a file only when its content differs (keeps mtimes stable on re-runs).
write_file() { # path mode content
  local path="$1" fmode="$2" content="$3"
  if [ -f "$path" ] && [ "$(cat "$path")" = "$content" ]; then
    say "unchanged $path"
    return
  fi
  if [ "$dry" = 1 ]; then echo "  would write: $path"; return; fi
  mkdir -p "$(dirname "$path")"
  local tmp
  tmp="$(mktemp "$(dirname "$path")/.carbon-install.XXXXXX")"
  printf '%s\n' "$content" > "$tmp"
  chmod "$fmode" "$tmp"
  mv -f "$tmp" "$path"
  say "wrote $path"
}

# Removes a file only if this script wrote it (it carries the marker).
remove_ours() {
  local path="$1"
  [ -e "$path" ] || return 0
  if grep -qF "$MARK" "$path" 2>/dev/null; then run rm -f "$path"; say "removed $path"
  else say "left $path (not installed by this script)"; fi
}

hypr_rule() {
  cat <<EOF
$MARK
# carbon gets a workspace of its own. Open it with \`carbon\`; the launcher focuses it if it's running.
# Hyprland 0.48+ syntax; on older versions use the windowrulev2 lines below instead.
windowrule = workspace name:carbon, class:^(carbon)\$
windowrule = tile, class:^(carbon)\$
# windowrulev2 = workspace name:carbon, class:^(carbon)\$
# windowrulev2 = tile, class:^(carbon)\$
EOF
}

uninstall() {
  echo "Uninstalling carbon"
  remove_ours "$LAUNCHER"
  remove_ours "$DESKTOP"
  remove_ours "$HYPR_SNIPPET"
  if [ -f "$HYPR_MAIN" ] && grep -qF "$MARK" "$HYPR_MAIN"; then
    if [ "$dry" = 1 ]; then echo "  would remove the source line from $HYPR_MAIN"
    else
      local tmp; tmp="$(mktemp "$HYPR_DIR/.carbon-install.XXXXXX")"
      grep -vF "$MARK" "$HYPR_MAIN" > "$tmp" || true
      cat "$tmp" > "$HYPR_MAIN" && rm -f "$tmp"
      say "removed the source line from $HYPR_MAIN"
    fi
  fi
  if [ -f "$APP_DIR/.installed-by-carbon" ]; then run rm -rf "$APP_DIR"; say "removed $APP_DIR"; fi
  if command -v update-desktop-database >/dev/null 2>&1 && [ "$dry" = 0 ]; then
    update-desktop-database "$DATA/applications" >/dev/null 2>&1 || true
  fi
  echo "Done. Worlds and settings are untouched."
}

install() {
  # Find what to install.
  if [ -z "$appimage" ] && [ -z "$unpacked" ]; then
    appimage="$(ls -t "$ROOT"/dist/*.AppImage 2>/dev/null | head -n1 || true)"
    if [ -z "$appimage" ] && [ -x "$ROOT/dist/linux-unpacked/carbon" ]; then unpacked="$ROOT/dist/linux-unpacked"; fi
  fi
  [ -n "$appimage" ] || [ -n "$unpacked" ] || die 'nothing to install: run `npm run dist` first, or pass --appimage/--dir'
  if [ -n "$appimage" ]; then [ -f "$appimage" ] || die "no such AppImage: $appimage"; fi
  if [ -n "$unpacked" ]; then [ -x "$unpacked/carbon" ] || die "no carbon executable in $unpacked"; fi

  echo "Installing carbon"
  run mkdir -p "$APP_DIR"
  local exe
  if [ -n "$appimage" ]; then
    exe="$APP_DIR/carbon.AppImage"
    if [ "$dry" = 1 ]; then echo "  would copy $appimage → $exe"
    elif ! cmp -s "$appimage" "$exe" 2>/dev/null; then
      cp -f "$appimage" "$exe.new" && chmod 755 "$exe.new" && mv -f "$exe.new" "$exe"
      say "installed $exe"
    else say "unchanged $exe"; fi
    run rm -rf "$APP_DIR/app"
  else
    exe="$APP_DIR/app/carbon"
    if [ "$dry" = 1 ]; then echo "  would copy $unpacked → $APP_DIR/app"
    else
      rm -rf "$APP_DIR/app.new" && cp -a "$unpacked" "$APP_DIR/app.new"
      rm -rf "$APP_DIR/app" && mv "$APP_DIR/app.new" "$APP_DIR/app"
      say "installed $APP_DIR/app"
    fi
    run rm -f "$APP_DIR/carbon.AppImage"
  fi
  [ "$dry" = 1 ] || : > "$APP_DIR/.installed-by-carbon"

  write_file "$LAUNCHER" 755 "#!/bin/sh
$MARK
# Focuses the running carbon (Hyprland), or starts it. Arguments go to carbon (e.g. --world DIR).
if [ \$# -eq 0 ] && command -v hyprctl >/dev/null 2>&1 &&
   hyprctl clients -j 2>/dev/null | grep -Eq '\"class\": *\"carbon\"'; then
  exec hyprctl dispatch focuswindow 'class:^(carbon)\$' >/dev/null
fi
exec \"$exe\" \"\$@\""

  write_file "$DESKTOP" 644 "[Desktop Entry]
$MARK
Type=Application
Name=carbon
Comment=A live design studio for Infinite
Exec=$LAUNCHER %U
Terminal=false
Categories=Development;
StartupWMClass=carbon"

  write_file "$HYPR_SNIPPET" 644 "$(hypr_rule)"

  if [ "$hypr" = 1 ]; then
    if [ -f "$HYPR_MAIN" ] && grep -qF "$MARK" "$HYPR_MAIN"; then say "unchanged $HYPR_MAIN"
    elif [ "$dry" = 1 ]; then echo "  would append the source line to $HYPR_MAIN"
    else
      mkdir -p "$HYPR_DIR"
      printf '\n%s\n' "$SOURCE_LINE" >> "$HYPR_MAIN"
      say "sourced the window rule from $HYPR_MAIN"
    fi
  fi

  if command -v update-desktop-database >/dev/null 2>&1 && [ "$dry" = 0 ]; then
    update-desktop-database "$DATA/applications" >/dev/null 2>&1 || true
  fi
  case ":$PATH:" in
    *":$BIN:"*) ;;
    *) echo "Note: $BIN is not on your PATH; add it to run \`carbon\`." ;;
  esac
  if [ "$hypr" = 0 ]; then
    echo "Window rule: add \`source = $HYPR_SNIPPET\` to hyprland.conf, or re-run with --hypr."
  fi
  echo "Done. Run \`carbon\` (or \`carbon --world ~/infinite-bible\`)."
}

if [ "$mode" = uninstall ]; then uninstall; else install; fi
