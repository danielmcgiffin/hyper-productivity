# Super Productivity: Cloudflare R2 Sync Provider

## Overview

Add a new sync provider called "CloudSync" to Super Productivity that stores sync data in a Cloudflare R2 bucket via a Worker. The Worker is ~60 lines. The SP provider implements the same `SyncProviderServiceInterface` as WebDAV/Dropbox.

**Architecture:** SP app → HTTPS → CF Worker (bearer auth) → R2 bucket

---

## Part 1: Cloudflare Worker + R2

### 1.1 Create `cf-worker/wrangler.toml`

```toml
name = "sp-sync"
main = "src/worker.ts"
compatibility_date = "2024-12-01"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "sp-sync"

[vars]
# Set actual token via `wrangler secret put AUTH_TOKEN`
```

### 1.2 Create `cf-worker/src/worker.ts`

```typescript
interface Env {
  BUCKET: R2Bucket;
  AUTH_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, PUT, DELETE, HEAD',
          'Access-Control-Allow-Headers':
            'Authorization, Content-Type, If-Match, If-None-Match',
          'Access-Control-Expose-Headers': 'ETag, Last-Modified',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Auth check
    const auth = request.headers.get('Authorization');
    if (auth !== `Bearer ${env.AUTH_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    const url = new URL(request.url);
    // Key = path without leading slash, e.g., "super-productivity/sync-data.json"
    const key = decodeURIComponent(url.pathname.slice(1));
    if (!key) {
      return new Response('Missing key', { status: 400 });
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'ETag, Last-Modified',
    };

    try {
      switch (request.method) {
        case 'HEAD': {
          const obj = await env.BUCKET.head(key);
          if (!obj) return new Response(null, { status: 404, headers: corsHeaders });
          return new Response(null, {
            status: 200,
            headers: {
              ...corsHeaders,
              ETag: obj.etag,
              'Last-Modified': obj.uploaded.toUTCString(),
            },
          });
        }

        case 'GET': {
          const obj = await env.BUCKET.get(key);
          if (!obj) return new Response(null, { status: 404, headers: corsHeaders });
          return new Response(obj.body, {
            headers: {
              ...corsHeaders,
              ETag: obj.etag,
              'Last-Modified': obj.uploaded.toUTCString(),
              'Content-Type': 'application/json',
            },
          });
        }

        case 'PUT': {
          // Conditional upload: If-Match checks ETag for conflict detection
          const ifMatch = request.headers.get('If-Match');
          if (ifMatch) {
            const existing = await env.BUCKET.head(key);
            if (existing && existing.etag !== ifMatch) {
              return new Response('Precondition Failed', {
                status: 412,
                headers: corsHeaders,
              });
            }
          }
          const body = await request.text();
          const result = await env.BUCKET.put(key, body);
          return new Response(null, {
            status: 200,
            headers: {
              ...corsHeaders,
              ETag: result.etag,
            },
          });
        }

        case 'DELETE': {
          await env.BUCKET.delete(key);
          return new Response(null, { status: 204, headers: corsHeaders });
        }

        default:
          return new Response('Method not allowed', {
            status: 405,
            headers: corsHeaders,
          });
      }
    } catch (e: any) {
      return new Response(`Internal error: ${e.message}`, {
        status: 500,
        headers: corsHeaders,
      });
    }
  },
} satisfies ExportedHandler<Env>;
```

### 1.3 Deploy

```bash
cd cf-worker
npm create cloudflare@latest -- --template=hello-world  # scaffold if needed
wrangler r2 bucket create sp-sync
wrangler secret put AUTH_TOKEN  # enter a long random token
wrangler deploy
```

The Worker URL will be `https://sp-sync.<your-subdomain>.workers.dev`.

---

## Part 2: SP Provider Implementation

### File 1: NEW — `src/app/op-log/sync-providers/file-based/cloud-sync/cloud-sync.model.ts`

```typescript
import { SyncProviderPrivateCfgBase } from '../../../core/types/sync.types';

export interface CloudSyncPrivateCfg extends SyncProviderPrivateCfgBase {
  baseUrl: string;
  authToken: string;
  syncFolderPath?: string;
}
```

### File 2: NEW — `src/app/op-log/sync-providers/file-based/cloud-sync/cloud-sync.ts`

```typescript
import {
  SyncProviderServiceInterface,
  FileRevResponse,
  FileDownloadResponse,
} from '../../provider.interface';
import { SyncProviderId } from '../../provider.const';
import {
  InvalidDataSPError,
  MissingCredentialsSPError,
  NoRevAPIError,
  RemoteFileNotFoundAPIError,
  UploadRevToMatchMismatchAPIError,
} from '../../../core/errors/sync-errors';
import { SyncLog } from '../../../../core/log';
import { SyncCredentialStore } from '../../credential-store.service';
import { CloudSyncPrivateCfg } from './cloud-sync.model';

/**
 * CloudSync provider — syncs to any HTTP endpoint that supports
 * GET / PUT / DELETE / HEAD with ETag-based conditional writes.
 *
 * Designed for a Cloudflare Worker + R2 backend but works with any
 * server implementing the same contract.
 */
export class CloudSync implements SyncProviderServiceInterface<SyncProviderId.CloudSync> {
  private static readonly L = 'CloudSync';

  readonly id = SyncProviderId.CloudSync;
  readonly isUploadForcePossible = true;
  readonly maxConcurrentRequests = 10;

  public privateCfg: SyncCredentialStore<SyncProviderId.CloudSync>;

  constructor(private _extraPath?: string) {
    this.privateCfg = new SyncCredentialStore(SyncProviderId.CloudSync);
  }

  async isReady(): Promise<boolean> {
    const cfg = await this.privateCfg.load();
    return !!(cfg && cfg.baseUrl && cfg.authToken);
  }

  async setPrivateCfg(privateCfg: CloudSyncPrivateCfg): Promise<void> {
    await this.privateCfg.setComplete(privateCfg);
  }

  async clearAuthCredentials(): Promise<void> {
    const cfg = await this.privateCfg.load();
    if (cfg?.authToken) {
      await this.privateCfg.setComplete({ ...cfg, authToken: '' });
    }
  }

  async getFileRev(
    targetPath: string,
    localRev: string | null,
  ): Promise<FileRevResponse> {
    const { url, headers } = await this._buildRequest(targetPath);
    const res = await fetch(url, { method: 'HEAD', headers });

    if (res.status === 404) {
      throw new RemoteFileNotFoundAPIError(`File not found: ${targetPath}`);
    }
    if (!res.ok) {
      throw new Error(`CloudSync HEAD failed: ${res.status} ${res.statusText}`);
    }

    const etag = res.headers.get('ETag');
    const lastMod = res.headers.get('Last-Modified');
    const rev = etag || lastMod || '';
    if (!rev) throw new NoRevAPIError();

    return { rev };
  }

  async downloadFile(targetPath: string): Promise<FileDownloadResponse> {
    SyncLog.debug(CloudSync.L, 'downloadFile', { targetPath });
    const { url, headers } = await this._buildRequest(targetPath);
    const res = await fetch(url, { method: 'GET', headers });

    if (res.status === 404) {
      throw new RemoteFileNotFoundAPIError(`File not found: ${targetPath}`);
    }
    if (!res.ok) {
      throw new Error(`CloudSync GET failed: ${res.status} ${res.statusText}`);
    }

    const dataStr = await res.text();
    if (dataStr == null) {
      throw new InvalidDataSPError(targetPath);
    }

    const etag = res.headers.get('ETag');
    const lastMod = res.headers.get('Last-Modified');
    const rev = etag || lastMod || '';
    if (!rev) throw new NoRevAPIError();

    return { rev, dataStr };
  }

  async uploadFile(
    targetPath: string,
    dataStr: string,
    revToMatch: string | null,
    isForceOverwrite: boolean = false,
  ): Promise<FileRevResponse> {
    SyncLog.debug(CloudSync.L, 'uploadFile', {
      targetPath,
      revToMatch,
      isForceOverwrite,
    });
    const { url, headers } = await this._buildRequest(targetPath);

    // Conditional write unless force overwrite
    if (revToMatch && !isForceOverwrite) {
      headers['If-Match'] = revToMatch;
    }
    headers['Content-Type'] = 'application/json';

    const res = await fetch(url, {
      method: 'PUT',
      headers,
      body: dataStr,
    });

    if (res.status === 412) {
      throw new UploadRevToMatchMismatchAPIError(
        'Remote file changed since last download (ETag mismatch)',
      );
    }
    if (!res.ok) {
      throw new Error(`CloudSync PUT failed: ${res.status} ${res.statusText}`);
    }

    const etag = res.headers.get('ETag');
    if (!etag) throw new NoRevAPIError();

    return { rev: etag };
  }

  async removeFile(targetPath: string): Promise<void> {
    SyncLog.debug(CloudSync.L, 'removeFile', { targetPath });
    const { url, headers } = await this._buildRequest(targetPath);
    const res = await fetch(url, { method: 'DELETE', headers });

    if (res.status === 404) {
      throw new RemoteFileNotFoundAPIError(`File not found: ${targetPath}`);
    }
    if (!res.ok) {
      throw new Error(`CloudSync DELETE failed: ${res.status} ${res.statusText}`);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private async _cfgOrError(): Promise<CloudSyncPrivateCfg> {
    const cfg = await this.privateCfg.load();
    if (!cfg) {
      throw new MissingCredentialsSPError('CloudSync configuration is missing.');
    }
    if (!cfg.baseUrl) {
      throw new MissingCredentialsSPError(
        'CloudSync base URL is not configured. Please check your sync settings.',
      );
    }
    if (!cfg.authToken) {
      throw new MissingCredentialsSPError(
        'CloudSync auth token is not configured. Please check your sync settings.',
      );
    }
    return cfg;
  }

  private _buildFilePath(targetPath: string, cfg: CloudSyncPrivateCfg): string {
    const parts = cfg.syncFolderPath ? [cfg.syncFolderPath] : ['super-productivity'];
    if (this._extraPath) {
      parts.push(this._extraPath);
    }
    parts.push(targetPath);
    return parts.join('/').replace(/\/+/g, '/');
  }

  private async _buildRequest(
    targetPath: string,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const cfg = await this._cfgOrError();
    const filePath = this._buildFilePath(targetPath, cfg);
    const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    const url = `${baseUrl}/${encodeURIComponent(filePath)}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cfg.authToken}`,
    };
    return { url, headers };
  }
}
```

---

## Part 3: Plumbing Diffs (exact edits to existing files)

### Edit 1: `src/app/op-log/sync-providers/provider.const.ts`

Add `CloudSync` to the enum:

```diff
 export enum SyncProviderId {
   'Dropbox' = 'Dropbox',
   'WebDAV' = 'WebDAV',
   'LocalFile' = 'LocalFile',
   'SuperSync' = 'SuperSync',
+  'CloudSync' = 'CloudSync',
 }
```

### Edit 2: `src/app/op-log/core/types/sync.types.ts`

Add import and type mapping:

```diff
 import type { DropboxPrivateCfg } from '../../sync-providers/file-based/dropbox/dropbox';
 import type { WebdavPrivateCfg } from '../../sync-providers/file-based/webdav/webdav.model';
 import type { SuperSyncPrivateCfg } from '../../sync-providers/super-sync/super-sync.model';
+import type { CloudSyncPrivateCfg } from '../../sync-providers/file-based/cloud-sync/cloud-sync.model';

 export type SyncProviderPrivateCfg =
   | DropboxPrivateCfg
   | WebdavPrivateCfg
   | SuperSyncPrivateCfg
-  | LocalFileSyncPrivateCfg;
+  | LocalFileSyncPrivateCfg
+  | CloudSyncPrivateCfg;

 export type PrivateCfgByProviderId<T extends SyncProviderId> =
   T extends SyncProviderId.LocalFile
     ? LocalFileSyncPrivateCfg
     : T extends SyncProviderId.WebDAV
       ? WebdavPrivateCfg
       : T extends SyncProviderId.Dropbox
         ? DropboxPrivateCfg
         : T extends SyncProviderId.SuperSync
           ? SuperSyncPrivateCfg
-          : never;
+          : T extends SyncProviderId.CloudSync
+            ? CloudSyncPrivateCfg
+            : never;
```

### Edit 3: `src/app/op-log/sync-providers/provider-manager.service.ts`

Add import and register provider:

```diff
 import { Dropbox } from './file-based/dropbox/dropbox';
 import { Webdav } from './file-based/webdav/webdav';
 import { SuperSyncProvider } from './super-sync/super-sync';
+import { CloudSync } from './file-based/cloud-sync/cloud-sync';
 import { LocalFileSyncElectron } from './file-based/local-file/local-file-sync-electron';
 import { LocalFileSyncAndroid } from './file-based/local-file/local-file-sync-android';
```

Add to `SYNC_PROVIDERS` array:

```diff
 const SYNC_PROVIDERS: SyncProviderServiceInterface<SyncProviderId>[] = [
   new Dropbox({
     appKey: DROPBOX_APP_KEY,
     basePath: environment.production ? `/` : `/DEV/`,
   }) as SyncProviderServiceInterface<SyncProviderId>,
   new Webdav(
     environment.production ? undefined : `/DEV`,
   ) as SyncProviderServiceInterface<SyncProviderId>,
   new SuperSyncProvider(
     environment.production ? undefined : `/DEV`,
   ) as SyncProviderServiceInterface<SyncProviderId>,
+  new CloudSync(
+    environment.production ? undefined : `/DEV`,
+  ) as SyncProviderServiceInterface<SyncProviderId>,
   ...(IS_ELECTRON
     ? [new LocalFileSyncElectron() as SyncProviderServiceInterface<SyncProviderId>]
     : []),
```

### Edit 4: `src/app/features/config/global-config.model.ts`

Add interface and config key:

```diff
+export interface CloudSyncConfig {
+  baseUrl?: string | null;
+  authToken?: string | null;
+  syncFolderPath?: string | null;
+}

 export type SyncConfig = Readonly<{
   isEnabled: boolean;
   isEncryptionEnabled?: boolean;
   isCompressionEnabled?: boolean;
   syncProvider: SyncProviderId | null;
   syncInterval: number;
   isManualSyncOnly?: boolean;

   /* NOTE: view model for form only*/
   encryptKey?: string | null;
   /* NOTE: view model for form only*/
   webDav?: WebDavConfig;
   /* NOTE: view model for form only*/
   superSync?: SuperSyncConfig;
   /* NOTE: view model for form only*/
   localFileSync?: LocalFileSyncConfig;
+  /* NOTE: view model for form only*/
+  cloudSync?: CloudSyncConfig;
 }>;
```

### Edit 5: `src/app/features/config/default-global-config.const.ts`

Add default config inside the `sync:` block (after the `localFileSync` or `superSync` block):

```diff
+    cloudSync: {
+      baseUrl: null,
+      authToken: null,
+      syncFolderPath: 'super-productivity',
+    },
```

### Edit 6: `src/app/features/config/form-cfgs/sync-form.const.ts`

Add CloudSync to the provider dropdown options:

```diff
         options: [
           { label: 'SuperSync (Beta)', value: SyncProviderId.SuperSync },
           { label: SyncProviderId.Dropbox, value: SyncProviderId.Dropbox },
           { label: 'WebDAV (experimental)', value: SyncProviderId.WebDAV },
+          { label: 'CloudSync (R2/S3)', value: SyncProviderId.CloudSync },
           ...(IS_ELECTRON || IS_ANDROID_WEB_VIEW
```

Add the form field group (insert after the WebDAV `fieldGroup` block and before the Dropbox block):

```typescript
    // CloudSync provider form fields
    {
      hideExpression: (m, v, field) =>
        field?.parent?.model.syncProvider !== SyncProviderId.CloudSync,
      resetOnHide: false,
      key: 'cloudSync',
      fieldGroup: [
        {
          type: 'tpl',
          templateOptions: {
            tag: 'p',
            text: 'Sync via a Cloudflare Worker + R2 (or any compatible HTTP endpoint with ETag support). Deploy your own worker for full data ownership.',
          },
        },
        {
          key: 'baseUrl',
          type: 'input',
          templateOptions: {
            label: 'Worker URL',
            description: '* https://sp-sync.your-subdomain.workers.dev',
          },
          expressions: {
            'props.required': (field: FormlyFieldConfig) =>
              field?.parent?.parent?.model?.syncProvider === SyncProviderId.CloudSync,
          },
        },
        {
          key: 'authToken',
          type: 'input',
          templateOptions: {
            type: 'password',
            label: 'Auth Token',
          },
          expressions: {
            'props.required': (field: FormlyFieldConfig) =>
              field?.parent?.parent?.model?.syncProvider === SyncProviderId.CloudSync,
          },
        },
        {
          key: 'syncFolderPath',
          type: 'input',
          templateOptions: {
            label: 'Sync Folder Path',
          },
        },
      ],
    },
```

### Edit 7: `src/app/imex/sync/sync-config.service.ts`

Add mapping entries:

```diff
 const PROP_MAP_TO_FORM: Record<SyncProviderId, keyof SyncConfig | null> = {
   [SyncProviderId.LocalFile]: 'localFileSync',
   [SyncProviderId.WebDAV]: 'webDav',
   [SyncProviderId.SuperSync]: 'superSync',
   [SyncProviderId.Dropbox]: null,
+  [SyncProviderId.CloudSync]: 'cloudSync',
 };
```

```diff
 const PROVIDER_FIELD_DEFAULTS: Record<
   SyncProviderId,
   Record<string, string | boolean>
 > = {
   [SyncProviderId.WebDAV]: {
     baseUrl: '',
     userName: '',
     password: '',
     syncFolderPath: '',
     encryptKey: '',
   },
   [SyncProviderId.SuperSync]: {
     baseUrl: '',
     userName: '',
     password: '',
     accessToken: '',
     syncFolderPath: '',
     encryptKey: '',
     isEncryptionEnabled: false,
   },
   [SyncProviderId.LocalFile]: {
     syncFolderPath: '',
     encryptKey: '',
   },
   [SyncProviderId.Dropbox]: {
     encryptKey: '',
   },
+  [SyncProviderId.CloudSync]: {
+    baseUrl: '',
+    authToken: '',
+    syncFolderPath: 'super-productivity',
+    encryptKey: '',
+  },
 };
```

Also add to the `syncSettingsForm$` deep merge block inside `switchMap`:

```diff
         superSync: {
           ...DEFAULT_GLOBAL_CONFIG.sync.superSync,
           ...syncCfg?.superSync,
         },
         webDav: {
           ...DEFAULT_GLOBAL_CONFIG.sync.webDav,
           ...syncCfg?.webDav,
         },
         localFileSync: {
           ...DEFAULT_GLOBAL_CONFIG.sync.localFileSync,
           ...syncCfg?.localFileSync,
         },
+        cloudSync: {
+          ...DEFAULT_GLOBAL_CONFIG.sync.cloudSync,
+          ...syncCfg?.cloudSync,
+        },
```

And in the "Reset provider-specific configs to defaults first" block:

```diff
       const result: SyncConfig = {
         ...baseConfig,
         encryptKey,
         isEncryptionEnabled,
         localFileSync: DEFAULT_GLOBAL_CONFIG.sync.localFileSync,
         webDav: DEFAULT_GLOBAL_CONFIG.sync.webDav,
         superSync: DEFAULT_GLOBAL_CONFIG.sync.superSync,
+        cloudSync: DEFAULT_GLOBAL_CONFIG.sync.cloudSync,
       };
```

---

## Part 4: Summary of All Files

### New files (3)

| File                                                                      | Description                   |
| ------------------------------------------------------------------------- | ----------------------------- |
| `cf-worker/src/worker.ts`                                                 | Cloudflare Worker — ~90 lines |
| `src/app/op-log/sync-providers/file-based/cloud-sync/cloud-sync.ts`       | Provider class — ~170 lines   |
| `src/app/op-log/sync-providers/file-based/cloud-sync/cloud-sync.model.ts` | Config interface — ~7 lines   |

### Modified files (7)

| File                                                        | Change                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| `src/app/op-log/sync-providers/provider.const.ts`           | Add `CloudSync` to enum                                                 |
| `src/app/op-log/core/types/sync.types.ts`                   | Add import + type mapping                                               |
| `src/app/op-log/sync-providers/provider-manager.service.ts` | Import + register provider                                              |
| `src/app/features/config/global-config.model.ts`            | Add `CloudSyncConfig` interface + `cloudSync` key                       |
| `src/app/features/config/default-global-config.const.ts`    | Add default config                                                      |
| `src/app/features/config/form-cfgs/sync-form.const.ts`      | Add dropdown option + form fields                                       |
| `src/app/imex/sync/sync-config.service.ts`                  | Add `PROP_MAP_TO_FORM` + `PROVIDER_FIELD_DEFAULTS` + deep merge entries |

### Total new code: ~270 lines SP-side, ~90 lines Worker

---

## Part 5: Testing Checklist

1. Deploy CF Worker and set AUTH_TOKEN secret
2. Build SP fork locally: `npm install && npm start`
3. Go to Settings → Sync → Enable → select "CloudSync (R2/S3)"
4. Enter Worker URL and auth token
5. Click Save — first sync should upload initial state
6. Open SP on second device, enter same config
7. Click Sync — should download state from first device
8. Create a task on device A, sync, verify it appears on device B
9. Test conflict: modify on both devices offline, sync both — should trigger conflict dialog
10. Test encryption: enable compression + E2EE in advanced settings, verify cross-device still works

---

## Notes

- The `FileBasedSyncAdapterService` automatically wraps any provider implementing `SyncProviderServiceInterface` into a full operation-sync-capable adapter. You get vector clocks, conflict resolution, compression, and E2EE for free.
- R2's ETags are strong ETags based on content hash — perfect for optimistic locking.
- The Worker uses `If-Match` for conditional PUT — this is what prevents two devices from stomping each other.
- CF Workers free tier: 100k requests/day, R2 free tier: 10GB storage, 10M reads/mo. For a single user syncing task JSON, this is effectively infinite.
