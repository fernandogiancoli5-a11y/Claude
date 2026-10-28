#!/usr/bin/env bash
# Starts the built Pairloom app for a Codespaces preview: the server serves the web app and the
# API on one port (8787), which Codespaces forwards privately to your browser.
set -euo pipefail
cd "$(dirname "$0")/.."
if curl -fs http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
  echo "Pairloom is already running: open the Ports tab and click the globe next to 8787."
  exit 0
fi
[ -f apps/web/dist/index.html ] || npm run build
if [ -n "${CODESPACE_NAME:-}" ]; then
  # The exact address the browser uses; needed for sign-in cookies and the API origin check.
  export PUBLIC_ORIGIN="https://${CODESPACE_NAME}-8787.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
fi
export WEB_DIST_DIR=./apps/web/dist
export PAIRLOOM_HOSTED_WORKERS=true
[ -n "${GROQ_API_KEY:-}" ] || echo "No GROQ_API_KEY secret: real AI tasks won't run (simulated tasks still work)."
echo "Starting Pairloom at ${PUBLIC_ORIGIN:-http://localhost:8787}"
exec node --import tsx apps/server/src/index.ts
