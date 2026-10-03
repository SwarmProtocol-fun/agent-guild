#!/usr/bin/env bash
# Agent Guild: compresses the DimSim models in public/dimsim/ in place.
# Upstream ships them raw (~210 MB); this brings them to a few tens of MB.
#
#   - scene GLBs: textures re-encoded to WebP and capped at 1024 px (2048 for
#     the room structure, which covers whole walls and floors). Geometry is left
#     exactly as is, because it becomes the Rapier colliders the robot and the
#     floor plan raycast against; meshopt quantization (~1 mm) flipped
#     wall-adjacent floor-plan cells.
#   - the robot (embodiment/, visual only): simplified and meshopt-compressed.
#     engine.js and AiAvatar.js register MeshoptDecoder for it.
#
# Files whose textures are already WebP (or robots already meshopt-compressed)
# are skipped, so it's safe to rerun.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../../public/dimsim" && pwd)"
CLI=(npx -y @gltf-transform/cli@4)

is_done() {
  python3 - "$1" <<'EOF'
import json, struct, sys
b = open(sys.argv[1], "rb").read(20 + 4_000_000)
n = struct.unpack("<I", b[12:16])[0]
j = json.loads(b[20:20 + n])
used = j.get("extensionsUsed", [])
sys.exit(0 if "EXT_texture_webp" in used or "EXT_meshopt_compression" in used else 1)
EOF
}

before=$(du -sb "$ROOT" | cut -f1)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

find "$ROOT" -name '*.glb' -print0 | while IFS= read -r -d '' f; do
  rel="${f#"$ROOT"/}"
  if is_done "$f"; then
    echo "skip  $rel"
    continue
  fi
  size=1024
  [[ "$rel" == */structure.glb ]] && size=2048
  # Individual steps, not `gltf-transform optimize`: that also flattens, joins
  # and prunes nodes, which moved geometry in structure.glb.
  if [[ "$rel" == embodiment/* ]]; then
    "${CLI[@]}" simplify "$f" "$TMP/a.glb" >/dev/null
    "${CLI[@]}" meshopt "$TMP/a.glb" "$f" >/dev/null
  else
    "${CLI[@]}" resize "$f" "$TMP/a.glb" --width "$size" --height "$size" >/dev/null
    "${CLI[@]}" webp "$TMP/a.glb" "$f" >/dev/null
  fi
  echo "done  $rel  $(du -h "$f" | cut -f1)"
done

after=$(du -sb "$ROOT" | cut -f1)
echo "public/dimsim: $((before / 1000000)) MB -> $((after / 1000000)) MB"
