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
npx ng build --configuration production

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
