#!/usr/bin/env bash
# Rebuild the icon font subset: public/fonts/wc-icons.woff2
#
# The app draws every icon from one Material Design glyph set that ships inside
# Symbols Nerd Font (2.5 MB, ~10.6k glyphs). Only the 18 below are used, so the
# subset gets them in 3 KB instead. Keep this list in sync with the .ic-* rules
# in style.css — a missing codepoint renders as a blank box, silently. The one
# exception is the disclosure chevron: it styles the <summary>'s ::before
# directly, so grep for its codepoint rather than a class name.
#
# Needs fonttools (pyftsubset) with brotli for the woff2 output.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="${SYMBOLS_FONT:-$HOME/Projects/distro/website/scripts/SymbolsNerdFont-Regular.ttf}"
OUT="public/fonts/wc-icons.woff2"
[ -f "$SRC" ] || { echo "font not found: $SRC (override with SYMBOLS_FONT=...)" >&2; exit 1; }

# U+  name                 used by
CODEPOINTS=(
  U+F0026   # md-alert          confirm dialog warning glyph
  U+F012C   # md-check          "copied" feedback
  U+F0142   # md-chevron_right  thinking-block disclosure (replaces the native triangle)
  U+F0156   # md-close          delete chat, forget memory, clear
  U+F018F   # md-content_copy   copy message / copy code
  U+F01DA   # md-download       sidebar import (arrow down: a file comes in)
  U+F0552   # md-upload         sidebar export  (arrow up: a file goes out)
  U+F035C   # md-menu           open the chat drawer
  U+F03EB   # md-pencil         rename chat
  U+F0415   # md-plus           new chat
  U+F0453   # md-reload         regenerate reply
  U+F048A   # md-send           send
  U+F0493   # md-cog            settings
  U+F04DB   # md-stop           stop streaming (the send key's other role)
  U+F0594   # md-weather_night  theme toggle, light side
  U+F522    # oct-sun           theme toggle, dark side (the glyph the distro website uses)
  U+F09D1   # md-brain          memory: sidebar, save-to-memory, remembered badge
  U+F05B7   # md-wrench         MCP tool-usage badge (model used an MCP tool)
)
ICONS=$(IFS=, ; echo "${CODEPOINTS[*]}")

mkdir -p public/fonts
pyftsubset "$SRC" \
  --output-file="$OUT" \
  --flavor=woff2 \
  --unicodes="$ICONS" \
  --layout-features='' \
  --drop-tables+=DSIG \
  --no-hinting \
  --ignore-missing-unicodes

echo "wrote $OUT ($(wc -c < "$OUT") bytes) from $(basename "$SRC")"
