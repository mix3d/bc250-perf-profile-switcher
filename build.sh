#!/usr/bin/env bash
set -e

PLUGIN_NAME=$(python3 -c "import json; print(json.load(open('plugin.json'))['name'])")
OUT_NAME="bc250-power"
OUT_DIR="out"

pnpm install --frozen-lockfile
pnpm build

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/$OUT_NAME"

cp main.py plugin.json package.json LICENSE "$OUT_DIR/$OUT_NAME/"
cp -r dist py_modules "$OUT_DIR/$OUT_NAME/"

cd "$OUT_DIR"
zip -r "$OUT_NAME.zip" "$OUT_NAME/"
echo "Built: $OUT_DIR/$OUT_NAME.zip"
