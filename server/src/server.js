const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const {
  generateMessageId,
  cookieIdentity,
  validateMessage,
  validateRegister,
  safeHostname,
  nowISO,
  nowEpoch,
} = require('./utils');

const VERBOSE = process.argv.includes('--verbose');

// Ensure data dir
if (!fs.existsSync(config.dataDir)) {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

// Track connections and rate limiting
const connections = new Map();     // instanceId -> { ws, browser, lastSeen }
const wsToInstance = new Map();   // ws -> instanceId
let heartbeatTimer = null;
let cleanupTimer = null;

// ─── Logger ──────────────────────────────────────────────────────────────────

function log(level, msg, data = {}) {
  const timestamp = nowISO();
  const line = `[${timestamp}] [${level}] ${msg}`;
  if (VERBOSE || level !== 'DEBUG') console.log(line);
  if (level === 'INFO' || level === 'WARN' || level === 'ERROR') {
    db.logSync(level, data.browserId || null, data.category || null, data);
  }
}

// ─── Rate Limiting ───────────────────────────────────────────────────────────

function isRateLimited(instanceId) {
  const conn = connections.get(instanceId);
  if (!conn) return false;
  if (!conn._msgTimestamps) conn._msgTimestamps = [];
  const now = nowEpoch();
  conn._msgTimestamps.push(now);
  conn._msgTimestamps = conn._msgTimestamps.filter(t => t > now - config.rateLimitWindowMs);
  return conn._msgTimestamps.length > config.rateLimitMaxMessages;
}

// ─── Broadcasting ────────────────────────────────────────────────────────────

function send(ws, message) {
  if (ws && ws.readyState === 1) {
    const payload = JSON.stringify(message);
    ws.send(payload);
  }
}

function broadcast(message, excludeInstanceId = null) {
  const payload = JSON.stringify(message);
  for (const [instanceId, conn] of connections) {
    if (instanceId !== excludeInstanceId && conn.ws.readyState === 1) {
      try { conn.ws.send(payload); } catch (_) {}
    }
  }
}

function broadcastToBrowsers(message, browsers, excludeInstanceId = null) {
  const payload = JSON.stringify(message);
  for (const [instanceId, conn] of connections) {
    if (instanceId === excludeInstanceId) continue;
    if (browsers.length > 0 && !browsers.includes(conn.browser)) continue;
    if (conn.ws.readyState === 1) {
      try { conn.ws.send(payload); } catch (_) {}
    }
  }
}

// ─── Ack ─────────────────────────────────────────────────────────────────────

function ack(ws, messageId) {
  send(ws, {
    type: 'ack',
    messageId,
    timestamp: nowEpoch(),
  });
}

// ─── Conflict Resolution ─────────────────────────────────────────────────────

// latestCookieVersions tracks the winning cookie state: domain::path::name -> { cookie, timestamp }
const latestCookieVersions = new Map();

function acceptLatestCookie(incomingCookie) {
  const identity = cookieIdentity(incomingCookie);
  const existing = latestCookieVersions.get(identity);
  const incomingTime = incomingCookie.updatedAt || 0;
  const incomingIsTombstone = !!incomingCookie.removed;

  if (!existing) {
    latestCookieVersions.set(identity, { cookie: incomingCookie, timestamp: incomingTime, tombstone: incomingIsTombstone });
    return { accepted: true, resurrected: false };
  }

  const existingTime = existing.timestamp || 0;
  const existingIsTombstone = existing.tombstone;

  // Newer timestamp always wins
  if (incomingTime > existingTime) {
    const isResurrected = existingIsTombstone && !incomingIsTombstone;
    latestCookieVersions.set(identity, { cookie: incomingCookie, timestamp: incomingTime, tombstone: incomingIsTombstone });
    return { accepted: true, resurrected: isResurrected };
  }

  // On equal timestamps, live cookies beat tombstones (resurrection)
  if (incomingTime === existingTime && existingIsTombstone && !incomingIsTombstone) {
    latestCookieVersions.set(identity, { cookie: incomingCookie, timestamp: incomingTime, tombstone: false });
    return { accepted: true, resurrected: true };
  }

  return { accepted: false, resurrected: false };
}


// ─── Sync Data Handler ───────────────────────────────────────────────────────

async function handleSync(instanceId, message) {
  const conn = connections.get(instanceId);
  if (!conn) return;

  const { category, payload, site } = message;

  // Empty payload = pull request via sync
  if (!payload || (payload.kind === 'raw' && Object.keys(payload.raw || {}).length === 0)) {
    return handlePull(instanceId, message);
  }

  log('INFO', `sync received`, { browserId: instanceId, category });

  // Ack all sync messages (extensions expect this)
  if (message.messageId) {
    ack(conn.ws, message.messageId);
  }

  switch (category) {
    case 'bookmarks':
    case 'bookmark_backup':
    case 'bookmarks_removed':
      await handleBookmarkSync(instanceId, message);
      break;
    case 'cookies':
      await handleCookieSync(instanceId, message);
      break;
    case 'localStorage':
    case 'sessionStorage':
      await handleStorageSync(instanceId, message);
      break;
    case 'browserState':
    case 'tabSharing':
      await handleTabSync(instanceId, message);
      break;
    case 'cookie_apply_result':
      log('DEBUG', 'cookie apply result', { browserId: instanceId, details: payload?.raw?.summary });
      break;
    case 'DEBUG_TREE':
      // Debug only, just log it
      break;
    default:
      log('DEBUG', `unhandled sync category: ${category}`, { browserId: instanceId });
  }

  // Save to global state for future pull requests.
  // Skip categories that save state in their own handlers to avoid double-writes.
  const selfSaving = [
    'bookmarks', 'bookmark_backup', 'bookmarks_removed',
    'cookies', 'localStorage', 'sessionStorage',
    'browserState', 'tabSharing',
    'cookie_apply_result', 'DEBUG_TREE'
  ];
  if (payload && category && !selfSaving.includes(category)) {
    db.saveGlobalState(category, site || '*', payload);
  }

  // Auto-sync: re-broadcast to all other clients.
  // Skip categories that broadcast in their own handlers to prevent double-broadcast.
  const selfBroadcasting = [
    'bookmarks', 'bookmarks_removed', 'bookmark_backup',
    'cookies', 'localStorage', 'sessionStorage',
    'browserState', 'tabSharing',
    'cookie_apply_result', 'DEBUG_TREE'
  ];
  const settings = db.getSettings();
  if (settings.automaticSync !== false && !selfBroadcasting.includes(category)) {
    broadcast(message, instanceId);
  }
}

// ─── Bookmark Sync ───────────────────────────────────────────────────────────

async function handleBookmarkSync(instanceId, message) {
  const { category, payload } = message;

  if (category === 'bookmarks_removed') {
    // Extensions send { bookmarksRemoved: bookmark } but Swift encodes as { bookmark: bookmark }
    const removedBookmark = payload?.bookmarksRemoved || payload?.bookmark;
    if (removedBookmark) {
      db.addToTrash(removedBookmark);
      log('INFO', `bookmark removed`, { browserId: instanceId, title: removedBookmark.title });
      // Re-broadcast removal to all other clients
      broadcast(message, instanceId);
    }
    return;
  }

  const bookmarks = payload?.bookmarks || [];
  if (category === 'bookmark_backup') {
    // Backup snapshot — save it for later diff comparison
    db.saveBookmarkSnapshot(instanceId, bookmarks);
    log('INFO', `bookmark backup saved`, { browserId: instanceId, count: bookmarks.length });
    return;
  }

  // Full bookmarks sync
  db.saveBookmarkSnapshot(instanceId, bookmarks);
  log('INFO', `bookmarks synced`, { browserId: instanceId, count: bookmarks.length });
  broadcast(message, instanceId);
}

// ─── Cookie Sync ─────────────────────────────────────────────────────────────

async function handleCookieSync(instanceId, message) {
  const cookies = message.payload?.cookies || [];
  if (cookies.length === 0) return;

  const settings = db.getSettings();
  const siteDomain = message.site && message.site !== '*' ? message.site : null;

  // Check per-site strategy override
  let conflictStrategy = settings.browserDataSyncStrategy || 'latest_wins';
  let stateSourceBrowser = settings.stateSourceBrowser || 'safari';

  if (siteDomain) {
    const siteSettings = (settings.websiteSettings || []).find(
      s => s.domain === siteDomain
    );
    if (siteSettings?.strategy) {
      conflictStrategy = siteSettings.strategy;
      stateSourceBrowser = siteSettings.sourceBrowser || stateSourceBrowser;
    }
  }

  const conn = connections.get(instanceId);
  const sourceBrowser = conn?.browser || 'unknown';

  const acceptedCookies = [];
  const resurrectedCookies = [];

  for (const cookie of cookies) {
    cookie._sourceBrowser = sourceBrowser;
    const identity = cookieIdentity(cookie);

    if (conflictStrategy === 'primary_wins') {
      if (sourceBrowser === stateSourceBrowser) {
        // Primary browser: always accept — it's the authoritative source
        latestCookieVersions.set(identity, { cookie, timestamp: cookie.updatedAt || nowEpoch(), tombstone: !!cookie.removed, browser: sourceBrowser });
        acceptedCookies.push(cookie);
      } else {
        // Non-primary browser: only accept if primary has no version yet
        const existing = latestCookieVersions.get(identity);
        if (!existing || existing.browser !== stateSourceBrowser) {
          latestCookieVersions.set(identity, { cookie, timestamp: cookie.updatedAt || nowEpoch(), tombstone: !!cookie.removed, browser: sourceBrowser });
          acceptedCookies.push(cookie);
        }
      }
    } else {
      // Latest-wins conflict resolution
      const result = acceptLatestCookie(cookie);
      if (result.accepted) {
        acceptedCookies.push(cookie);
        if (result.resurrected) {
          resurrectedCookies.push(cookie);
        }
      }
    }

  }

  // Handle tombstones only for accepted cookies — rejected cookies
  // must not pollute the tombstone DB with stale data.
  for (const cookie of acceptedCookies) {
    const identity = cookieIdentity(cookie);
    if (cookie.removed) {
      db.setCookieTombstone(identity, cookie, cookie.updatedAt || nowEpoch());
    } else {
      db.removeCookieTombstone(identity);
    }
  }

  log('INFO', `cookie sync`, {
    browserId: instanceId,
    count: cookies.length,
    accepted: acceptedCookies.length,
    resurrected: resurrectedCookies.length,
  });

  // Broadcast accepted cookies
  if (acceptedCookies.length > 0) {
    broadcast({
      type: 'sync',
      browser: sourceBrowser,
      site: message.site || '*',
      category: 'cookies',
      payload: { kind: 'cookies', cookies: acceptedCookies },
      messageId: generateMessageId(),
      timestamp: nowEpoch(),
    }, instanceId);
  }

  // Resurrected cookies must be broadcast to ALL clients (including sender)
  if (resurrectedCookies.length > 0) {
    const resurrectMsg = {
      type: 'sync',
      browser: sourceBrowser,
      site: message.site || '*',
      category: 'cookies',
      payload: { kind: 'cookies', cookies: resurrectedCookies },
      messageId: generateMessageId(),
      timestamp: nowEpoch(),
    };
    broadcast(resurrectMsg);
  }
}

// ─── Storage Sync ────────────────────────────────────────────────────────────

async function handleStorageSync(instanceId, message) {
  const { category, payload, site } = message;
  const items = payload?.[category] || [];
  if (items.length === 0) return;

  const storageDomain = site && site !== '*' ? site : (items[0]?.origin ? safeHostname(items[0].origin) : null);

  log('INFO', `${category} sync`, { browserId: instanceId, count: items.length });

  broadcast(message, instanceId);
  db.saveGlobalState(category, storageDomain || '*', payload);
}

// ─── Tab Sync ────────────────────────────────────────────────────────────────

async function handleTabSync(instanceId, message) {
  const { category, payload } = message;
  const tabs = payload?.tabs || [];
  const conn = connections.get(instanceId);

  if (tabs.length === 0) return;

  // Filter for tab sharing
  let filteredTabs = tabs;
  if (category === 'tabSharing') {
    filteredTabs = tabs.filter(t => !t.incognito && /^https?:\/\//i.test(t.url));
  }

  // Map with source browser
  const mapped = filteredTabs.map(tab => ({
    id: String(tab.id),
    url: tab.url,
    title: tab.title || '',
    isActive: tab.active || false,
    windowId: String(tab.windowId || ''),
    index: typeof tab.index === 'number' ? tab.index : 0,
    favIconURL: tab.favIconUrl || '',
    sourceBrowser: conn?.browser || tab.sourceBrowser || 'unknown',
    capturedAt: nowEpoch(),
  }));

  if (mapped.length === 0) return;

  log('INFO', `tab sync ${category}`, { browserId: instanceId, count: mapped.length });

  const outbound = {
    type: 'sync',
    browser: conn?.browser || 'unknown',
    category,
    payload: { kind: 'tabs', tabs: mapped },
    messageId: generateMessageId(),
    timestamp: nowEpoch(),
  };

  broadcast(outbound, instanceId);

  // Merge tabs into global state — don't overwrite other browsers' tabs
  const existing = db.getGlobalState(category, '*');
  const existingTabs = existing?.tabs || [];
  const otherTabs = existingTabs.filter(t => t.sourceBrowser !== (conn?.browser || 'unknown'));
  const merged = [...otherTabs, ...mapped];
  db.saveGlobalState(category, '*', { tabs: merged });
}

// ─── Pull Handler ────────────────────────────────────────────────────────────

async function handlePull(instanceId, message) {
  const { category, site } = message;
  const conn = connections.get(instanceId);
  if (!conn) return;

  log('INFO', `pull request`, { browserId: instanceId, category, site });

  switch (category) {
    case 'bookmarks': {
      // Broadcast pull to other clients so they send fresh bookmarks
      broadcast({
        type: 'pull',
        category: 'bookmarks',
        messageId: generateMessageId(),
        timestamp: nowEpoch(),
      }, instanceId);

      // Also serve cached snapshot immediately — prefer online clients
      const allClients = db.getAllClients();
      let snapshot = null;
      // Try online clients first
      for (const client of allClients) {
        if (client.instance_id === instanceId) continue;
        if (client.online) {
          snapshot = db.getBookmarkSnapshot(client.instance_id);
          if (snapshot) break;
        }
      }
      // Fall back to any snapshot
      if (!snapshot) {
        for (const client of allClients) {
          if (client.instance_id === instanceId) continue;
          snapshot = db.getBookmarkSnapshot(client.instance_id);
          if (snapshot) break;
        }
      }
      if (snapshot) {
        send(conn.ws, {
          type: 'sync',
          category: 'bookmarks',
          payload: { kind: 'bookmarks', bookmarks: snapshot.bookmarks },
          isFullMirror: false,
          messageId: generateMessageId(),
          timestamp: nowEpoch(),
        });
      }
      break;
    }

    case 'browserData': {
      // Pull cookies + localStorage + sessionStorage
      broadcast({
        type: 'pull',
        category: 'browserData',
        site,
        messageId: generateMessageId(),
        timestamp: nowEpoch(),
      }, instanceId);

      // Also serve cached state immediately
      const cachedCookies = db.getGlobalState('cookies', site || '*');
      if (cachedCookies) {
        send(conn.ws, {
          type: 'sync',
          category: 'cookies',
          payload: cachedCookies,
          messageId: generateMessageId(),
          timestamp: nowEpoch(),
        });
      }
      const cachedLocal = db.getGlobalState('localStorage', site || '*');
      if (cachedLocal) {
        send(conn.ws, {
          type: 'sync',
          category: 'localStorage',
          payload: cachedLocal,
          messageId: generateMessageId(),
          timestamp: nowEpoch(),
        });
      }
      const cachedSession = db.getGlobalState('sessionStorage', site || '*');
      if (cachedSession) {
        send(conn.ws, {
          type: 'sync',
          category: 'sessionStorage',
          payload: cachedSession,
          messageId: generateMessageId(),
          timestamp: nowEpoch(),
        });
      }
      break;
    }

    case 'cookies': {
      broadcast({
        type: 'pull',
        category: 'cookies',
        site,
        messageId: generateMessageId(),
        timestamp: nowEpoch(),
      }, instanceId);

      const cached = db.getGlobalState('cookies', site || '*');
      if (cached) {
        send(conn.ws, {
          type: 'sync',
          category: 'cookies',
          payload: cached,
          messageId: generateMessageId(),
          timestamp: nowEpoch(),
        });
      }
      // Also include tombstones
      const tombstones = db.getCookieTombstones();
      const siteTombs = site && site !== '*'
        ? tombstones.filter(t => t.domain?.includes(site))
        : tombstones;
      if (siteTombs.length > 0) {
        send(conn.ws, {
          type: 'sync',
          category: 'cookies',
          payload: { kind: 'cookies', cookies: siteTombs },
          messageId: generateMessageId(),
          timestamp: nowEpoch(),
        });
      }
      break;
    }

    case 'browserState':
    case 'tabSharing': {
      broadcast({
        type: 'pull',
        category,
        messageId: generateMessageId(),
        timestamp: nowEpoch(),
      }, instanceId);

      const cached = db.getGlobalState(category, '*');
      if (cached) {
        send(conn.ws, {
          type: 'sync',
          category,
          payload: { kind: 'tabs', tabs: cached.tabs || [] },
          messageId: generateMessageId(),
          timestamp: nowEpoch(),
        });
      }

      // For tab sharing, also send tabs from offline clients
      if (category === 'tabSharing') {
        const allClients = db.getAllClients();
        for (const client of allClients) {
          if (client.instance_id === instanceId) continue;
          if (!client.online) {
            const cachedTabs = db.getGlobalState('tabSharing', '*');
            if (cachedTabs?.tabs?.some(t => t.sourceBrowser === client.browser)) {
              const clientTabs = cachedTabs.tabs.filter(t => t.sourceBrowser === client.browser);
              send(conn.ws, {
                type: 'sync',
                browser: `${client.browser}_offline`,
                category: 'tabSharing',
                payload: { kind: 'tabs', tabs: clientTabs },
                messageId: generateMessageId(),
                timestamp: nowEpoch(),
              });
            }
          }
        }
      }
      break;
    }

    case 'localStorage':
    case 'sessionStorage': {
      broadcast({
        type: 'pull',
        category,
        site,
        messageId: generateMessageId(),
        timestamp: nowEpoch(),
      }, instanceId);

      const cached = db.getGlobalState(category, site || '*');
      if (cached) {
        send(conn.ws, {
          type: 'sync',
          category,
          payload: cached,
          messageId: generateMessageId(),
          timestamp: nowEpoch(),
        });
      }
      break;
    }

    case undefined:
    case null:
    case '': {
      // Generic pull — pull everything
      log('INFO', 'full pull requested', { browserId: instanceId });

      // Send settings first
      const settings = db.getSettings();
      if (Object.keys(settings).length > 0) {
        send(conn.ws, {
          type: 'settings',
          payload: { kind: 'raw', raw: settings },
          messageId: generateMessageId(),
          timestamp: nowEpoch(),
        });
      }

      // Pull from all other clients
      broadcast({
        type: 'pull',
        messageId: generateMessageId(),
        timestamp: nowEpoch(),
      }, instanceId);

      // Serve cached bookmarks from snapshot table
      const allClients = db.getAllClients();
      for (const client of allClients) {
        const snapshot = db.getBookmarkSnapshot(client.instance_id);
        if (snapshot) {
          send(conn.ws, {
            type: 'sync',
            category: 'bookmarks',
            payload: { kind: 'bookmarks', bookmarks: snapshot.bookmarks },
            messageId: generateMessageId(),
            timestamp: nowEpoch(),
          });
          break;
        }
      }

      // Serve cached cookies
      const cookieCache = db.getGlobalState('cookies', '*');
      if (cookieCache) {
        // Strip tombstones from pull cache
        const liveCookies = (cookieCache.cookies || []).filter(c => !c.removed);
        if (liveCookies.length > 0) {
          send(conn.ws, {
            type: 'sync',
            category: 'cookies',
            payload: { kind: 'cookies', cookies: liveCookies },
            messageId: generateMessageId(),
            timestamp: nowEpoch(),
          });
        }
      }
      break;
    }

    default: {
      log('DEBUG', `unhandled pull category: ${category}`, { browserId: instanceId });
    }
  }
}

// ─── Settings Handler ────────────────────────────────────────────────────────

function handleSettings(instanceId, message) {
  const { payload } = message;
  if (!payload || payload.kind !== 'raw') return;

  const raw = payload.raw || {};
  const settings = db.getSettings();

  // Merge incoming settings
  if (raw.routerDefault !== undefined) settings.routerDefault = raw.routerDefault;
  if (raw.tabSharingEnabled !== undefined) settings.tabSharingEnabled = raw.tabSharingEnabled;
  if (raw.stateParticipatingBrowsers !== undefined) settings.stateParticipatingBrowsers = raw.stateParticipatingBrowsers;
  if (raw.bookmarkParticipatingBrowsers !== undefined) settings.bookmarkParticipatingBrowsers = raw.bookmarkParticipatingBrowsers;
  if (raw.tabSharingParticipatingBrowsers !== undefined) settings.tabSharingParticipatingBrowsers = raw.tabSharingParticipatingBrowsers;
  if (raw.websiteListPolicy !== undefined) settings.websiteListPolicy = raw.websiteListPolicy;
  if (raw.websiteSettings !== undefined) settings.websiteSettings = raw.websiteSettings;
  if (raw.installedBrowsers !== undefined) settings.installedBrowsers = raw.installedBrowsers;
  if (raw.syncDisabledDomains !== undefined) settings.syncDisabledDomains = raw.syncDisabledDomains;
  if (raw.automaticSync !== undefined) settings.automaticSync = raw.automaticSync;
  if (raw.browserDataSyncStrategy !== undefined) settings.browserDataSyncStrategy = raw.browserDataSyncStrategy;
  if (raw.stateSourceBrowser !== undefined) settings.stateSourceBrowser = raw.stateSourceBrowser;

  // Handle per-site toggles and strategies
  if (raw.toggleSiteSync) {
    const { domain, value } = raw.toggleSiteSync;
    const ws = settings.websiteSettings || [];
    const idx = ws.findIndex(s => s.domain === domain);
    if (value && idx === -1) {
      ws.push({ domain, strategy: null, sourceBrowser: null });
    } else if (!value && idx !== -1) {
      ws.splice(idx, 1);
    }
    settings.websiteSettings = ws;
  }

  if (raw.updateSiteStrategy) {
    const { domain, strategy } = raw.updateSiteStrategy;
    const ws = settings.websiteSettings || [];
    const idx = ws.findIndex(s => s.domain === domain);
    if (idx !== -1) {
      ws[idx].strategy = strategy;
    }
    settings.websiteSettings = ws;
  }

  if (raw.updateSiteSourceBrowser) {
    const { domain, browser } = raw.updateSiteSourceBrowser;
    const ws = settings.websiteSettings || [];
    const idx = ws.findIndex(s => s.domain === domain);
    if (idx !== -1) {
      ws[idx].sourceBrowser = browser;
    }
    settings.websiteSettings = ws;
  }

  db.saveSettings(settings);

  // Broadcast settings to all clients except sender
  broadcast({
    type: 'settings',
    payload: { kind: 'raw', raw: settings },
    messageId: generateMessageId(),
    timestamp: nowEpoch(),
  }, instanceId);

  log('INFO', 'settings updated', { browserId: instanceId });
}

// ─── Register Handler ────────────────────────────────────────────────────────

async function handleRegister(ws, message) {
  const error = validateRegister(message);
  if (error) {
    send(ws, { type: 'error', message: error });
    ws.close(4000, error);
    return;
  }

  const { browser, instanceId } = message;

  // Check auth if required
  if (config.authRequired) {
    const authHeader = message.authToken;
    if (authHeader !== config.authToken) {
      send(ws, { type: 'error', message: 'Unauthorized' });
      ws.close(4001, 'Unauthorized');
      log('WARN', 'rejected unauthorized connection', { instanceId });
      return;
    }
  }

  // Reconnect — close old connection for same instanceId
  const existing = connections.get(instanceId);
  if (existing && existing.ws !== ws && existing.ws.readyState === 1) {
    log('WARN', 'replacing stale connection', { instanceId });
    try { existing.ws.close(4002, 'Replaced by new connection'); } catch (_) {}
  }

  // Deduplicate stale offline clients with same browser
  const deduped = db.deduplicateClients(browser, instanceId);
  for (const staleId of deduped) {
    connections.delete(staleId);
  }

  // Upsert client in DB
  db.upsertClient(instanceId, browser);

  // Track connection
  connections.set(instanceId, { ws, browser, lastSeen: new Date(), _msgTimestamps: [], authenticated: true });
  wsToInstance.set(ws, instanceId);

  // Ack registration
  ack(ws, message.messageId);

  // Send full settings
  const settings = db.getSettings();
  if (Object.keys(settings).length > 0) {
    send(ws, {
      type: 'settings',
      payload: { kind: 'raw', raw: settings },
      messageId: generateMessageId(),
      timestamp: nowEpoch(),
    });
  }

  // Deliver any pending messages
  const pending = db.getPendingMessages(instanceId);
  if (pending.length > 0) {
    const pendingIds = pending.map(p => p.id);
    for (const p of pending) {
      send(ws, p.message);
    }
    db.clearAllPendingMessages(instanceId, pendingIds);
    log('INFO', `delivered ${pending.length} pending messages`, { browserId: instanceId });
  }

  log('INFO', `client registered`, { browserId: instanceId, browser });
}

// ─── Open URL Handler ────────────────────────────────────────────────────────

function handleOpenUrl(instanceId, message) {
  const { payload } = message;
  if (!payload || payload.kind !== 'raw') return;

  const { targetBrowser, url } = payload.raw || {};
  if (!targetBrowser || !url) {
    const conn = connections.get(instanceId);
    send(conn?.ws, { type: 'error', message: 'Invalid open_url payload' });
    return;
  }

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Invalid protocol');
    }
  } catch {
    const conn = connections.get(instanceId);
    send(conn?.ws, { type: 'error', message: 'Invalid URL' });
    return;
  }

  // Route URL to target browser: find online client with matching browser
  let delivered = false;
  for (const [id, conn] of connections) {
    if (conn.browser === targetBrowser && conn.ws.readyState === 1) {
      send(conn.ws, {
        type: 'open_url',
        payload: { kind: 'raw', raw: { targetBrowser, url } },
        messageId: generateMessageId(),
        timestamp: nowEpoch(),
      });
      delivered = true;
      break;
    }
  }

  if (!delivered) {
    // Find the actual instanceId for the target browser (not hardcoded to -main)
    let targetInstanceId = `${targetBrowser}-main`;
    const allClients = db.getAllClients();
    const targetClient = allClients.find(c => c.browser === targetBrowser);
    if (targetClient) {
      targetInstanceId = targetClient.instance_id;
    }
    db.queuePendingMessage(targetInstanceId, {
      type: 'open_url',
      payload: { kind: 'raw', raw: { targetBrowser, url } },
      messageId: generateMessageId(),
      timestamp: nowEpoch(),
    });
    log('INFO', `open_url queued for offline browser`, { targetBrowser, url });
  } else {
    log('INFO', `open_url delivered`, { targetBrowser, url });
  }
}

// ─── Open Settings Handler ───────────────────────────────────────────────────

function handleOpenSettings(instanceId) {
  // In remote mode, open_settings becomes a no-op or notification
  // The main app handles this locally; remote clients can't open macOS settings
  log('DEBUG', 'open_settings requested (remote mode — no-op)', { browserId: instanceId });
}

// ─── Message Router ──────────────────────────────────────────────────────────

async function routeMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString().trim());
  } catch {
    log('WARN', 'invalid JSON message');
    return;
  }

  const validationError = validateMessage(msg);
  if (validationError) {
    send(ws, { type: 'error', message: validationError });
    return;
  }

  const instanceId = wsToInstance.get(ws);

  // Allow register without instanceId check
  if (msg.type === 'register') {
    return handleRegister(ws, msg);
  }

  // Auth check
  if (config.authRequired) {
    const connInfo = instanceId ? connections.get(instanceId) : null;
    if (!connInfo) {
      send(ws, { type: 'error', message: 'Not registered. Send register first.' });
      ws.close(4003, 'Not registered');
      return;
    }
    if (!connInfo.authenticated) {
      send(ws, { type: 'error', message: 'Unauthorized' });
      return;
    }
  }

  if (!instanceId) {
    send(ws, { type: 'error', message: 'Not registered. Send register first.' });
    ws.close(4003, 'Not registered');
    return;
  }

  // Rate limit
  if (isRateLimited(instanceId)) {
    send(ws, { type: 'error', message: 'Rate limited' });
    return;
  }

  // Update last seen
  const conn = connections.get(instanceId);
  if (conn) conn.lastSeen = new Date();

  if (VERBOSE) {
    log('DEBUG', `msg: ${msg.type}`, { browserId: instanceId, category: msg.category });
  }

  switch (msg.type) {
    case 'sync':
      await handleSync(instanceId, msg);
      break;

    case 'pull':
      await handlePull(instanceId, msg);
      break;

    case 'heartbeat':
      db.updateLastSeen(instanceId);
      if (conn) conn.lastSeen = new Date();
      break;

    case 'settings':
      handleSettings(instanceId, msg);
      break;

    case 'open_settings':
      handleOpenSettings(instanceId);
      break;

    case 'open_url':
      handleOpenUrl(instanceId, msg);
      break;

    case 'disconnect':
      log('INFO', 'client requested disconnect', { browserId: instanceId });
      ws.close(1000, 'Client disconnect');
      break;

    case 'ack':
      // No server-side action needed
      break;

    case 'error':
      log('WARN', `client error`, { browserId: instanceId, error: msg.error });
      break;

    default:
      log('DEBUG', `unknown message type: ${msg.type}`, { browserId: instanceId });
  }
}

// ─── WebSocket Server ────────────────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const stats = db.getStats();
    const browserDetails = {};
    const allClients = db.getAllClients();
    for (const c of allClients) {
      browserDetails[c.instance_id] = {
        browser: c.browser,
        online: !!c.online,
        lastSeen: c.last_seen,
      };
    }
    res.end(JSON.stringify({
      status: 'ok',
      version: require('../package.json').version,
      uptime: process.uptime(),
      stats,
      browsers: browserDetails,
    }));
    return;
  }

  if (req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const stats = db.getStats();
    const allClients = db.getAllClients();
    res.end(JSON.stringify({
      ...stats,
      clientCount: allClients.length,
      clients: allClients.map(c => ({
        id: c.instance_id,
        browser: c.browser,
        online: !!c.online,
        lastSeen: c.last_seen,
      })),
      memoryUsage: process.memoryUsage(),
    }));
    return;
  }

  if (req.url === '/logs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const logs = db.getRecentLogs(200);
    res.end(JSON.stringify(logs));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: config.maxMessageSize,
});

wss.on('connection', (ws) => {
  log('DEBUG', 'new connection');

  ws.on('message', (raw) => {
    routeMessage(ws, raw).catch(err => {
      log('ERROR', 'message handling error', { error: err.message });
    });
  });

  ws.on('close', () => {
    const instanceId = wsToInstance.get(ws);
    if (instanceId) {
      db.markClientOffline(instanceId);
      connections.delete(instanceId);
      wsToInstance.delete(ws);

      // Notify other clients
      const conn = db.getClient(instanceId);
      broadcast({
        type: 'presence',
        browserId: instanceId,
        browserName: conn?.browser,
        online: false,
        lastSeen: nowISO(),
      });

      log('INFO', 'client disconnected', { browserId: instanceId });
    }
  });

  ws.on('error', (err) => {
    log('ERROR', 'ws error', { error: err.message });
  });
});

// ─── Heartbeat Monitor ───────────────────────────────────────────────────────

function startHeartbeatMonitor() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    const now = new Date();
    for (const [instanceId, conn] of connections) {
      const age = now - conn.lastSeen;
      if (age > config.heartbeatTimeoutMs) {
        log('WARN', 'heartbeat timeout, disconnecting', { browserId: instanceId });
        try {
          conn.ws.close(4004, 'Heartbeat timeout');
        } catch (_) {}
        db.markClientOffline(instanceId);
        connections.delete(instanceId);
        wsToInstance.delete(conn.ws);
        broadcast({
          type: 'presence',
          browserId: instanceId,
          browserName: conn.browser,
          online: false,
          lastSeen: nowISO(),
        });
      }
    }
  }, config.heartbeatIntervalMs);
}

// ─── Cleanup Timer ───────────────────────────────────────────────────────────

function startCleanupTimer() {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = setInterval(() => {
    db.cleanupStaleData();
    db.pruneOldLogs();
  }, 3600000); // Every hour
}

// ─── Startup ─────────────────────────────────────────────────────────────────

httpServer.listen(config.port, config.host, () => {
  // Mark all clients offline on restart
  db.markAllOffline();

  const stats = db.getStats();
  console.log(`[BrowSync Server] ws://${config.host}:${config.port}`);
  console.log(`[BrowSync Server] Health: http://${config.host}:${config.port}/health`);
  console.log(`[BrowSync Server] ${stats.clients.total} known client(s), ${stats.clients.online} online`);
  console.log(`[BrowSync Server] Auth: ${config.authRequired ? 'required' : 'disabled'}`);
  console.log(`[BrowSync Server] Data dir: ${path.resolve(config.dataDir)}`);

  startHeartbeatMonitor();
  startCleanupTimer();
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

function shutdown() {
  console.log('\n[BrowSync Server] Shutting down...');

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);

  db.markAllOffline();

  for (const [instanceId, conn] of connections) {
    try { conn.ws.close(1001, 'Server shutdown'); } catch (_) {}
  }
  connections.clear();
  wsToInstance.clear();

  // Give pending writes a moment to flush
  wss.close(() => {
    httpServer.close(() => {
      db.close();
      process.exit(0);
    });
  });

  // Safety: force exit after 5s
  setTimeout(() => process.exit(0), 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
