#!/usr/bin/env bash
set -euo pipefail

# Optimizes raw Gemini-API generated textures into compact 512x512 web-ready PNGs
# under public/textures/ (~30-120 KB each, matte stylized Firewatch aesthetic).
#
# Usage:
#   bash tools/art/optimize-textures.sh <raw_dir> [out_dir]

RAW_DIR="${1:-}"
OUT_DIR="${2:-public/textures}"

if [[ -z "$RAW_DIR" || ! -d "$RAW_DIR" ]]; then
  echo "Usage: $0 <raw_textures_dir> [public/textures]" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

encode_palette_png() {
  local input="$1"
  local vf="$2"
  local max_colors="$3"
  local dither="$4"
  local output="$5"

  ffmpeg -y -v error -i "$input" \
    -filter_complex "${vf},split[s0][s1];[s0]palettegen=max_colors=${max_colors}:stats_mode=single[p];[s1][p]paletteuse=dither=${dither}" \
    -compression_level 9 -pred none "$output"
}

# 1. plane-albedo.png (512x512, neutral light weathered painted aluminum skin)
encode_palette_png \
  "${RAW_DIR}/plane-albedo-raw.jpg" \
  "scale=512:512:flags=lanczos,eq=brightness=0.03:contrast=1.04:saturation=0.75" \
  96 "none" \
  "${OUT_DIR}/plane-albedo.png"

# 2. plane-bump.png (512x512, pure grayscale heightmap aligned with plane-albedo)
encode_palette_png \
  "${RAW_DIR}/plane-bump-raw.jpg" \
  "scale=512:512:flags=lanczos,format=gray,eq=contrast=1.18" \
  64 "none" \
  "${OUT_DIR}/plane-bump.png"

# 3. pine-foliage.png (512x512, lifted matte conifer needle detail for clean tinting)
encode_palette_png \
  "${RAW_DIR}/pine-foliage-raw.jpg" \
  "scale=512:512:flags=lanczos,hqdn3d=2.0:2.0:3:3,eq=gamma=1.35:brightness=0.07:contrast=0.96:saturation=0.58" \
  16 "none" \
  "${OUT_DIR}/pine-foliage.png"

# 4. pine-bark.png (512x512, matte weathered cedar/fir bark)
encode_palette_png \
  "${RAW_DIR}/pine-bark-raw.jpg" \
  "scale=512:512:flags=lanczos,hqdn3d=2.2:2.2:3:3,eq=gamma=1.16:brightness=0.05:contrast=1.02:saturation=0.92" \
  16 "none" \
  "${OUT_DIR}/pine-bark.png"

# 5. terrain-detail.png (512x512, subtle high-value matte forest floor grain for vertex-color multiply)
encode_palette_png \
  "${RAW_DIR}/terrain-detail-raw.jpg" \
  "scale=512:512:flags=lanczos,hqdn3d=2.5:2.5:3:3,eq=contrast=0.56:brightness=0.15:saturation=0.35" \
  16 "none" \
  "${OUT_DIR}/terrain-detail.png"

# 6. cabin-wood.png (512x512 2-band atlas: top y=0..255 [v=0.5..1.0] corrugated roof, bottom y=256..511 [v=0.0..0.5] timber logs)
ffmpeg -y -v error \
  -i "${RAW_DIR}/cabin-roof-raw.jpg" \
  -i "${RAW_DIR}/cabin-logs-raw.jpg" \
  -filter_complex "\
    [0:v]crop=iw:ih/2:0:0,scale=512:256:flags=lanczos,eq=gamma=1.12:brightness=0.04:contrast=1.02[roof]; \
    [1:v]crop=iw:ih/2:0:ih/4,scale=512:256:flags=lanczos,eq=gamma=1.12:brightness=0.04:contrast=1.02[logs]; \
    [roof][logs]vstack=inputs=2,split[s0][s1]; \
    [s0]palettegen=max_colors=96:stats_mode=single[p]; \
    [s1][p]paletteuse=dither=none" \
  -compression_level 9 -pred none "${OUT_DIR}/cabin-wood.png"

echo "Optimized textures in ${OUT_DIR}:"
ls -lh "${OUT_DIR}"/*.png
