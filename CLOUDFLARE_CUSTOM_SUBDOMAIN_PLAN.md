# Plan: Move Hyper Productivity to a Custom Subdomain

## Goal

Serve the app from a custom subdomain (for example `app.yourdomain.com`) and keep CloudSync working through a stable API endpoint (for example `sync.yourdomain.com`).

## Current State

- Pages project `sp-app` exists as a **Direct Upload** project (not Git-connected).
- Worker `sp-sync` is deployed and already handling sync requests.
- CloudSync provider fix is committed (`cloudflare fix`).

## Recommended Approach

Use a **new Git-connected Pages project** from the Cloudflare dashboard so pushes auto-build/deploy, then attach custom domains.

## Phase 1: Create Git-Connected Pages Project

1. In Cloudflare Dashboard, go to `Workers & Pages` -> `Create application` -> `Pages` -> `Connect to Git`.
2. Select repo: `danielmcgiffin/hyper-productivity`.
3. Set build config:
   - Framework preset: `Angular`
   - Build command: `npm ci && npx ng build --configuration production`
   - Build output directory: `dist/super-productivity/browser`
4. Add env vars required for build (if used by app):
   - `CLOUDFLARE_API_TOKEN` is not required for dashboard Git builds.
   - Add only runtime build vars your app references.
5. Deploy and confirm you get a `*.pages.dev` URL.

## Phase 2: Attach App Custom Subdomain

1. In that Pages project, open `Custom domains`.
2. Add `app.yourdomain.com`.
3. If your DNS is in Cloudflare, it will auto-create the record.
4. If external DNS, add CNAME manually:
   - `app.yourdomain.com` -> `<your-pages-project>.pages.dev`
5. Wait for SSL status to become `Active`.

## Phase 3: Attach Worker Custom Subdomain (Sync API)

1. In Cloudflare Dashboard, open Worker `sp-sync`.
2. Add a Custom Domain route, e.g. `sync.yourdomain.com`.
3. Keep Worker auth secret `AUTH_TOKEN` unchanged unless rotating.
4. Test endpoint:
   - `HEAD https://sync.yourdomain.com/super-productivity%2Fping.json`
   - Expect `401` without token, `200/404` with valid bearer token depending on object existence.

## Phase 4: Update App Sync Config

On each client (desktop/mobile/web):

1. Open Settings -> Sync -> CloudSync.
2. Set:
   - Base URL: `https://sync.yourdomain.com`
   - Auth Token: current `AUTH_TOKEN` value
   - Folder Path: `super-productivity` (or your chosen namespace)
3. Save.
4. Click `Sync now`.
5. If this is first bootstrap from a populated device, use `Force overwrite` once.

## Phase 5: Verification Checklist

- App loads at `https://app.yourdomain.com`.
- Sync no longer returns instant no-op for CloudSync.
- `sync-data.json` appears in R2 under expected key prefix.
- Changes made on device A appear on device B after manual sync.

## Rollback Plan

- Keep existing `sp-app.pages.dev` URL active until custom domain is verified.
- If custom domain fails, revert clients to worker `workers.dev` URL and old Pages URL.

## Notes

- Direct Upload Pages projects do not auto-build on push.
- Git-connected Pages projects are preferred for repeatable deployment and lower local machine load.
