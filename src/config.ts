// ABOUTME: Configuration management for ALF (Atproto Latency Fabric) service

import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

export interface ServiceConfig {
  port: number;
  serviceUrl: string;
  plcRoot: string;
  /** URL for resolving ATProto handles (e.g. a PDS or AppView). Defaults to Bsky AppView. */
  handleResolverUrl: string;
  databaseType: 'sqlite' | 'postgres';
  databasePath: string;
  databaseUrl?: string;
  encryptionKey: string;
  /** Optional URL to POST to after a draft is successfully published */
  postPublishWebhookUrl?: string;
  /** Maximum number of active drafts per user. null = unlimited. */
  maxDraftsPerUser: number | null;
  /** When true, createSchedule is rejected with a 403. For demo deployments. */
  disableRecurring: boolean;
  /**
   * Comma-separated ATProto collection NSIDs to allow. Defaults to "*" (all collections).
   * Used to build the OAuth scope: `repo:<collection>?action=create`.
   * Example: "app.bsky.feed.post" to restrict to Bluesky posts only.
   */
  allowedCollections: string;
  /** OAuth scope string derived from allowedCollections. Single source of truth. */
  oauthScope: string;
}

export const getConfig = (): ServiceConfig => {
  const databaseType = (process.env.DATABASE_TYPE || 'sqlite') as 'sqlite' | 'postgres';

  const maxDraftsPerUserRaw = process.env.MAX_DRAFTS_PER_USER;
  const maxDraftsPerUser = maxDraftsPerUserRaw ? parseInt(maxDraftsPerUserRaw, 10) : null;

  const config = {
    port: parseInt(process.env.ALF_PORT || process.env.PORT || '1986', 10),
    serviceUrl: process.env.ALF_SERVICE_URL || process.env.SERVICE_URL || 'http://localhost:1986',
    plcRoot: process.env.PLC_ROOT || 'https://plc.directory',
    handleResolverUrl: process.env.HANDLE_RESOLVER_URL || process.env.PDS_URL || 'https://api.bsky.app',
    databaseType,
    databasePath: process.env.DATABASE_PATH || './data/alf.db',
    databaseUrl: process.env.DATABASE_URL,
    encryptionKey: process.env.ENCRYPTION_KEY || '',
    postPublishWebhookUrl: process.env.POST_PUBLISH_WEBHOOK_URL,
    maxDraftsPerUser,
    disableRecurring: ['true', '1', 'yes'].includes((process.env.DISABLE_RECURRING || '').toLowerCase()),
    allowedCollections: process.env.ALLOWED_COLLECTIONS || '*',
    oauthScope: `atproto repo:${process.env.ALLOWED_COLLECTIONS || '*'}?action=create blob:*/*`,
  };

  if (config.databaseType === 'postgres' && !config.databaseUrl) {
    throw new Error('DATABASE_URL is required when DATABASE_TYPE is "postgres"');
  }
  if (!config.encryptionKey) {
    throw new Error('ENCRYPTION_KEY is required - generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(config.encryptionKey)) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }

  return config as ServiceConfig;
};
