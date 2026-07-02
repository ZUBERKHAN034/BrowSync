module.exports = {
  port: parseInt(process.env.PORT, 10) || 62333,
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.DATA_DIR || './data',

  heartbeatIntervalMs: 30_000,
  heartbeatTimeoutMs: 120_000,

  maxMessageSize: 50 * 1024 * 1024,
  maxTabsPerBrowser: 500,
  maxCookiesPerSync: 10000,
  maxBookmarksPerSync: 50000,
  maxStorageItemsPerSync: 50000,

  rateLimitWindowMs: 10_000,
  rateLimitMaxMessages: 50,

  authToken: process.env.BROWSYNC_AUTH_TOKEN || null,
  authRequired: process.env.BROWSYNC_AUTH_TOKEN ? true : false,

  staleDays: 30,

  logRetentionDays: 30,
};
