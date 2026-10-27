#!/usr/bin/env bash
# Creates a small throwaway git repo for trying Pairloom without touching a real project.
# Usage: scripts/demo-repo.sh [path]   (default: ./data/demo-repo)
set -euo pipefail
target="${1:-./data/demo-repo}"
if [ -e "$target" ]; then echo "$target already exists"; exit 0; fi
mkdir -p "$target"
cd "$target"
git init -q -b main
cat > inventory.js <<'JS'
// Rogue-style inventory. Bug: no capacity limit.
export function addItem(inventory, item) {
  inventory.push(item);
  return inventory;
}
JS
echo "# Demo game" > README.md
git add -A
git -c user.name=Pairloom -c user.email=demo@pairloom.invalid commit -q -m "Initial demo project"
echo "Demo repo ready at $(pwd)"
