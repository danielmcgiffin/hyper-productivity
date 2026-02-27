#!/usr/bin/env bash
set -euo pipefail

# Load API token from .env if present
if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "Error: CLOUDFLARE_API_TOKEN is not set."
  exit 1
fi

echo "Building Super Productivity..."
npm install --prefer-offline

# Codespaces can kill high-parallel Angular builds (shows up as "Terminated"/esbuild deadlock).
# Use conservative defaults and retry once with single worker if needed.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
export NG_BUILD_MAX_WORKERS="${NG_BUILD_MAX_WORKERS:-2}"
if ! npx ng build --configuration production; then
  echo "Initial build failed; retrying with NG_BUILD_MAX_WORKERS=1..."
  NG_BUILD_MAX_WORKERS=1 npx ng build --configuration production
fi

# Detect output directory
OUT_DIR="dist/super-productivity/browser"
if [ ! -d "$OUT_DIR" ]; then
  OUT_DIR="dist/super-productivity"
fi
if [ ! -d "$OUT_DIR" ]; then
  OUT_DIR=".tmp/angular-dist/browser"
fi
if [ ! -d "$OUT_DIR" ]; then
  OUT_DIR=".tmp/angular-dist"
fi

echo "Deploying to Cloudflare Pages..."
npx wrangler pages deploy "$OUT_DIR" --project-name sp-app

echo "Done. App available at https://sp-app.pages.dev"
