# Task: Add CloudSync provider to Super Productivity

You are adding a new sync provider called "CloudSync" to the Super Productivity app. This provider syncs data via a Cloudflare Worker + R2 bucket using simple HTTP (GET/PUT/DELETE/HEAD) with ETag-based optimistic locking.

Read `IMPLEMENTATION.md` thoroughly before making any changes. It contains the complete spec: new files, exact diffs for existing files, and the Cloudflare Worker.

## Context

Super Productivity is an Angular + ngrx app. Sync providers implement `SyncProviderServiceInterface` from `src/app/op-log/sync-providers/provider.interface.ts`. The existing providers (WebDAV, Dropbox, LocalFile) are in `src/app/op-log/sync-providers/file-based/`. The `FileBasedSyncAdapterService` automatically wraps any provider implementing this interface into a full operation-sync-capable adapter — you do NOT need to touch the sync engine.

## Steps

### 1. Create new files

Create these files exactly as specified in IMPLEMENTATION.md:

- `src/app/op-log/sync-providers/file-based/cloud-sync/cloud-sync.model.ts` — config interface
- `src/app/op-log/sync-providers/file-based/cloud-sync/cloud-sync.ts` — provider class

### 2. Apply diffs to existing files (7 files)

Apply each diff from IMPLEMENTATION.md Part 3 in order:

1. `src/app/op-log/sync-providers/provider.const.ts` — add `CloudSync` to `SyncProviderId` enum
2. `src/app/op-log/core/types/sync.types.ts` — add import, union member, and type mapping
3. `src/app/op-log/sync-providers/provider-manager.service.ts` — add import and register in `SYNC_PROVIDERS` array
4. `src/app/features/config/global-config.model.ts` — add `CloudSyncConfig` interface and `cloudSync` key to `SyncConfig`
5. `src/app/features/config/default-global-config.const.ts` — add default config block
6. `src/app/features/config/form-cfgs/sync-form.const.ts` — add dropdown option and form field group
7. `src/app/imex/sync/sync-config.service.ts` — add entries to `PROP_MAP_TO_FORM`, `PROVIDER_FIELD_DEFAULTS`, deep merge block, and reset block

### 3. Verify build

Run `npm install && npx ng build` and fix any TypeScript errors. Common issues to watch for:

- The `SyncProviderId.CloudSync` enum value must match the string `'CloudSync'` exactly
- The `PrivateCfgByProviderId` conditional type chain must include the `CloudSync` branch before the `: never` fallback
- The `FormlyFieldConfig` import is already present in `sync-form.const.ts` — don't duplicate it
- The `SyncProviderId` import in `sync-form.const.ts` is already present — don't duplicate it

### 4. Create the Cloudflare Worker (separate from SP build)

Create the Worker files in a new `cf-worker/` directory at the repo root:

- `cf-worker/wrangler.toml`
- `cf-worker/src/worker.ts`

These are standalone and not part of the Angular build.

## Constraints

- Do NOT modify any existing sync provider code (WebDAV, Dropbox, LocalFile, SuperSync)
- Do NOT modify the sync engine (`FileBasedSyncAdapterService`, `OperationLogSyncService`, etc.)
- Do NOT add new npm dependencies to the SP app — the provider uses only the browser `fetch` API
- Match the code style of the existing WebDAV provider (`webdav-base-provider.ts`) for consistency
- All provider config is stored via `SyncCredentialStore` (IndexedDB), NOT in global config JSON
