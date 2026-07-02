const Database = require('better-sqlite3');
const path = require('path');
const config = require('./config');

let db;

function getDb() {
  if (!db) {
    db = new Database(path.join(config.dataDir, 'browsync.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate();
  }
  return db;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      instance_id TEXT PRIMARY KEY,
      browser TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      online INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS global_state (
      key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bookmarks_snapshot (
      browser_id TEXT PRIMARY KEY,
      bookmarks TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bookmark_trash (
      id TEXT PRIMARY KEY,
      bookmark_data TEXT NOT NULL,
      deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cookie_tombstones (
      identity_key TEXT PRIMARY KEY,
      cookie_data TEXT NOT NULL,
      timestamp REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_instance_id TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      browser_id TEXT,
      category TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_global_state_key ON global_state(key);
    CREATE INDEX IF NOT EXISTS idx_pending_target ON pending_messages(target_instance_id);
    CREATE INDEX IF NOT EXISTS idx_sync_log_created ON sync_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_clients_online ON clients(online);
  `);
}

// ─── Clients ─────────────────────────────────────────────────────────────────

function upsertClient(instanceId, browser) {
  const db = getDb();
  const existing = db.prepare('SELECT instance_id FROM clients WHERE instance_id = ?').get(instanceId);
  if (existing) {
    db.prepare(`
      UPDATE clients SET browser = ?, last_seen = datetime('now'), online = 1 WHERE instance_id = ?
    `).run(browser, instanceId);
  } else {
    db.prepare(`
      INSERT INTO clients (instance_id, browser, last_seen, online) VALUES (?, ?, datetime('now'), 1)
    `).run(instanceId, browser);
  }
}

function markClientOffline(instanceId) {
  const db = getDb();
  db.prepare(`
    UPDATE clients SET online = 0, last_seen = datetime('now') WHERE instance_id = ?
  `).run(instanceId);
}

function markAllOffline() {
  const db = getDb();
  db.prepare('UPDATE clients SET online = 0').run();
}

function getClient(instanceId) {
  const db = getDb();
  return db.prepare('SELECT * FROM clients WHERE instance_id = ?').get(instanceId);
}

function getAllClients() {
  const db = getDb();
  return db.prepare('SELECT * FROM clients ORDER BY browser').all();
}

function getOnlineClients(excludeInstanceId) {
  const db = getDb();
  let query = 'SELECT * FROM clients WHERE online = 1';
  const params = [];
  if (excludeInstanceId) {
    query += ' AND instance_id != ?';
    params.push(excludeInstanceId);
  }
  return db.prepare(query).all(...params);
}

function deduplicateClients(browser, newInstanceId) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT instance_id FROM clients WHERE browser = ? AND instance_id != ? AND online = 0
  `);
  const stale = stmt.all(browser, newInstanceId);
  for (const row of stale) {
    db.prepare('DELETE FROM clients WHERE instance_id = ?').run(row.instance_id);
    db.prepare('DELETE FROM pending_messages WHERE target_instance_id = ?').run(row.instance_id);
  }
  return stale.map(r => r.instance_id);
}

function updateLastSeen(instanceId) {
  const db = getDb();
  db.prepare(`UPDATE clients SET last_seen = datetime('now') WHERE instance_id = ?`).run(instanceId);
}

// ─── Global State ────────────────────────────────────────────────────────────

function saveGlobalState(category, site, payload) {
  const db = getDb();
  const key = site ? `${category}_${site}` : category;
  db.prepare(`
    INSERT INTO global_state (key, payload, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(payload));
}

function getGlobalState(category, site) {
  const db = getDb();
  const key = site ? `${category}_${site}` : category;
  const row = db.prepare('SELECT payload FROM global_state WHERE key = ?').get(key);
  return row ? JSON.parse(row.payload) : null;
}

function getGlobalStatesByCategory(category) {
  const db = getDb();
  const prefix = `${category}_`;
  const rows = db.prepare('SELECT key, payload FROM global_state WHERE key LIKE ?').all(`${prefix}%`);
  return rows.map(r => ({ key: r.key, payload: JSON.parse(r.payload) }));
}

function deleteGlobalState(category, site) {
  const db = getDb();
  const key = site ? `${category}_${site}` : category;
  db.prepare('DELETE FROM global_state WHERE key = ?').run(key);
}

// ─── Bookmarks Snapshot ──────────────────────────────────────────────────────

function saveBookmarkSnapshot(browserId, bookmarks) {
  const db = getDb();
  db.prepare(`
    INSERT INTO bookmarks_snapshot (browser_id, bookmarks, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(browser_id) DO UPDATE SET bookmarks = excluded.bookmarks, updated_at = excluded.updated_at
  `).run(browserId, JSON.stringify(bookmarks));
}

function getBookmarkSnapshot(browserId) {
  const db = getDb();
  const row = db.prepare('SELECT bookmarks, updated_at FROM bookmarks_snapshot WHERE browser_id = ?').get(browserId);
  if (!row) return null;
  return { bookmarks: JSON.parse(row.bookmarks), updatedAt: row.updated_at };
}

// ─── Bookmark Trash ──────────────────────────────────────────────────────────

function addToTrash(bookmark) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO bookmark_trash (id, bookmark_data, deleted_at) VALUES (?, ?, datetime('now'))
  `).run(bookmark.id, JSON.stringify(bookmark));
}

function getTrashBookmarks() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM bookmark_trash ORDER BY deleted_at DESC LIMIT 500').all();
  return rows.map(r => JSON.parse(r.bookmark_data));
}

// ─── Cookie Tombstones ───────────────────────────────────────────────────────

function setCookieTombstone(identityKey, cookieData, timestamp) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO cookie_tombstones (identity_key, cookie_data, timestamp) VALUES (?, ?, ?)
  `).run(identityKey, JSON.stringify(cookieData), timestamp);
}

function getCookieTombstones() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM cookie_tombstones').all();
  return rows.map(r => ({ ...JSON.parse(r.cookie_data), updatedAt: r.timestamp }));
}

function removeCookieTombstone(identityKey) {
  const db = getDb();
  db.prepare('DELETE FROM cookie_tombstones WHERE identity_key = ?').run(identityKey);
}

// ─── Settings ────────────────────────────────────────────────────────────────

function saveSettings(settings) {
  const db = getDb();
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES ('app', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(JSON.stringify(settings));
}

function getSettings() {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'app'").get();
  return row ? JSON.parse(row.value) : {};
}

function updateSettings(partial) {
  const settings = getSettings();
  Object.assign(settings, partial);
  saveSettings(settings);
  return settings;
}

// ─── Pending Messages ────────────────────────────────────────────────────────

function queuePendingMessage(targetInstanceId, message) {
  const db = getDb();
  db.prepare(`
    INSERT INTO pending_messages (target_instance_id, message, created_at)
    VALUES (?, ?, datetime('now'))
  `).run(targetInstanceId, JSON.stringify(message));
}

function getPendingMessages(targetInstanceId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, message FROM pending_messages WHERE target_instance_id = ? ORDER BY created_at ASC
  `).all(targetInstanceId);
  return rows.map(r => ({ id: r.id, message: JSON.parse(r.message) }));
}

function clearPendingMessages(targetInstanceId) {
  const db = getDb();
  db.prepare('DELETE FROM pending_messages WHERE target_instance_id = ?').run(targetInstanceId);
}

function clearAllPendingMessages(targetInstanceId, messageIds) {
  if (!messageIds || messageIds.length === 0) return;
  const db = getDb();
  const placeholders = messageIds.map(() => '?').join(',');
  const params = [...messageIds, targetInstanceId];
  db.prepare(`DELETE FROM pending_messages WHERE id IN (${placeholders}) AND target_instance_id = ?`).run(...params);
}

// ─── Sync Log ────────────────────────────────────────────────────────────────

function logSync(eventType, browserId, category, details) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO sync_log (event_type, browser_id, category, details, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(eventType, browserId, category, details ? JSON.stringify(details) : null);
  } catch (_) {
    // Log writing should never crash the server
  }
}

function pruneOldLogs(retentionDays = config.logRetentionDays) {
  try {
    const db = getDb();
    db.prepare(`
      DELETE FROM sync_log WHERE created_at < datetime('now', '-' || ? || ' days')
    `).run(retentionDays);
  } catch (_) {}
}

function getRecentLogs(limit = 100) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM sync_log ORDER BY created_at DESC LIMIT ?').all(limit);
  return rows.map(r => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

function cleanupStaleData() {
  try {
    const db = getDb();
    db.prepare(`
      DELETE FROM clients WHERE online = 0 AND last_seen < datetime('now', '-' || ? || ' days')
    `).run(config.staleDays);
    db.prepare(`
      DELETE FROM cookie_tombstones WHERE timestamp < ?
    `).run(Date.now() - config.staleDays * 86400000);
  } catch (_) {}
}

function getStats() {
  const db = getDb();
  const clientsTotal = db.prepare('SELECT COUNT(*) as count FROM clients').get();
  const clientsOnline = db.prepare('SELECT COUNT(*) as count FROM clients WHERE online = 1').get();
  const pendingCount = db.prepare('SELECT COUNT(*) as count FROM pending_messages').get();
  const stateEntries = db.prepare('SELECT COUNT(*) as count FROM global_state').get();

  return {
    clients: { total: clientsTotal.count, online: clientsOnline.count },
    pendingMessages: pendingCount.count,
    globalStateEntries: stateEntries.count,
  };
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  getDb,
  // Clients
  upsertClient,
  markClientOffline,
  markAllOffline,
  getClient,
  getAllClients,
  getOnlineClients,
  deduplicateClients,
  updateLastSeen,
  // Global State
  saveGlobalState,
  getGlobalState,
  getGlobalStatesByCategory,
  deleteGlobalState,
  // Bookmarks
  saveBookmarkSnapshot,
  getBookmarkSnapshot,
  // Trash
  addToTrash,
  getTrashBookmarks,
  // Cookie tombstones
  setCookieTombstone,
  getCookieTombstones,
  removeCookieTombstone,
  // Settings
  saveSettings,
  getSettings,
  updateSettings,
  // Pending
  queuePendingMessage,
  getPendingMessages,
  clearPendingMessages,
  clearAllPendingMessages,
  // Logging
  logSync,
  pruneOldLogs,
  getRecentLogs,
  // Maintenance
  cleanupStaleData,
  getStats,
  close,
};
