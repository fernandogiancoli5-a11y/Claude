#!/usr/bin/env bash
# Materialises the disposable sample app (samples/tiny-cart) as its own git repository,
# for a Pairloom worker to operate on. Safe to delete and recreate at any time.
# Usage: scripts/sample-repo.sh [target]   (default: ./data/sample-repo)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
target="${1:-./data/sample-repo}"
if [ -e "$target" ]; then echo "$target already exists (delete it to recreate)"; exit 0; fi
mkdir -p "$target"
cp -R "$here/samples/tiny-cart/." "$target/"
cd "$target"
git init -q -b main
git add -A
git -c user.name="Pairloom Sample" -c user.email=sample@pairloom.invalid -c commit.gpgsign=false \
  commit -q -m "tiny-cart sample app"
echo "Sample repo ready at $(pwd)"
