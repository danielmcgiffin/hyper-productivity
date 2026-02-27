import {
  FileDownloadResponse,
  FileRevResponse,
  SyncProviderServiceInterface,
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
    void localRev;
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
