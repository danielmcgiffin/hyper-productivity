import { SyncProviderPrivateCfgBase } from '../../../core/types/sync.types';

export interface CloudSyncPrivateCfg extends SyncProviderPrivateCfgBase {
  baseUrl: string;
  authToken: string;
  syncFolderPath?: string;
}
