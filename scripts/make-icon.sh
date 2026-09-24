#!/bin/sh
# Renders assets/icon/puck.svg into the macOS icon set and puck.icns.
# Uses only tools that ship with macOS: qlmanage (SVG to PNG), sips
# (resize), iconutil (icns). Run after changing the SVG, then commit the
# regenerated puck.iconset and puck.icns.
set -eu
cd "$(dirname "$0")/../assets/icon"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
qlmanage -t -s 1024 -o "$tmp" puck.svg >/dev/null 2>&1
mv "$tmp/puck.svg.png" "$tmp/puck-1024.png"
rm -rf puck.iconset
mkdir puck.iconset
for size in 16 32 128 256 512; do
  double=$((size * 2))
  sips -z "$size" "$size" "$tmp/puck-1024.png" --out "puck.iconset/icon_${size}x${size}.png" >/dev/null
  sips -z "$double" "$double" "$tmp/puck-1024.png" --out "puck.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns puck.iconset -o puck.icns
echo "wrote assets/icon/puck.iconset and assets/icon/puck.icns"
