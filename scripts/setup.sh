#!/usr/bin/env bash
# Setup for the Pi Relevance Filter extension on Linux and macOS (idempotent).
#
#   1. Installs dev dependencies and typechecks the extension
#   2. Registers this directory in ~/.pi/agent/settings.json (the filter stays OFF until PI_RELEVANCE_FILTER=1)
#   3. Checks whether a Relevance Filter service answers on the configured URL
#
# The service itself is a separate project: https://github.com/Mikael-Gustavsson/relevance-filter
#
# Usage: scripts/setup.sh [--skip-register]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REGISTER=1
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-register) REGISTER=0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
step() { printf '\n==> %s\n' "$1"; }

step "Dependencies and typecheck"
npm install --no-audit --no-fund --silent
npx tsc --noEmit -p .

if [ "$REGISTER" = 1 ]; then
  step "Register extension in ~/.pi/agent/settings.json (disabled until PI_RELEVANCE_FILTER=1)"
  node - "$ROOT" <<'EOF'
const fs = require("fs"), path = require("path"), os = require("os");
const ext = process.argv[2];
const p = path.join(os.homedir(), ".pi", "agent", "settings.json");
const s = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, "")) : {};
const exts = Array.isArray(s.extensions) ? s.extensions : [];
if (exts.includes(ext)) {
  console.log("  already registered");
} else {
  if (fs.existsSync(p)) fs.copyFileSync(p, p.replace(/\.json$/, ".json.bak"));
  s.extensions = [...exts, ext];
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(s, null, 2));
  console.log(`  added ${ext} (backup: settings.json.bak)`);
}
EOF
fi

step "Relevance Filter service"
URL="${PI_RELEVANCE_FILTER_URL:-http://127.0.0.1:8765}"
if curl -sf --max-time 3 "$URL/v1/health" > /dev/null; then
  echo "  $URL answers"
else
  echo "  no service on $URL. Install and start it: https://github.com/Mikael-Gustavsson/relevance-filter"
fi

printf '\nSetup complete. Next (with the service running):\n'
echo "  PI_RELEVANCE_FILTER=1 pi"
