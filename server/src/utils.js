const { randomUUID } = require('crypto');

const BROWSERS = ['chrome', 'safari', 'firefox', 'arc', 'edge', 'brave'];

function generateMessageId() {
  return randomUUID();
}

function cookieIdentity(cookie) {
  return `${cookie.domain}::${cookie.path || '/'}::${cookie.name}`;
}

function validateMessage(msg) {
  if (!msg || typeof msg !== 'object') return 'Message must be a JSON object';
  if (!msg.type || typeof msg.type !== 'string') return 'Message must have a type field';
  return null;
}

function validateRegister(msg) {
  if (!msg.browser || !BROWSERS.includes(msg.browser)) return `Invalid browser: ${msg.browser}`;
  if (!msg.instanceId || typeof msg.instanceId !== 'string' || msg.instanceId.length > 100) return 'Invalid instanceId';
  if (msg.instanceId === 'null' || msg.instanceId === 'undefined') return 'Invalid instanceId';
  return null;
}

function validateTab(tab) {
  if (!tab || !tab.url) return false;
  try {
    const parsed = new URL(tab.url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function validateTabsArray(tabs, maxTabs) {
  if (!Array.isArray(tabs)) return [];
  return tabs.slice(0, maxTabs).map(t => ({
    id: typeof t.id === 'number' ? t.id : 0,
    url: typeof t.url === 'string' ? String(t.url).slice(0, 2048) : '',
    title: typeof t.title === 'string' ? String(t.title).slice(0, 500) : 'New Tab',
    favIconUrl: typeof t.favIconUrl === 'string' ? String(t.favIconUrl).slice(0, 2048) : '',
    pinned: !!t.pinned,
    windowId: typeof t.windowId === 'number' ? t.windowId : 0,
    active: !!t.active,
    lastAccessed: typeof t.lastAccessed === 'number' ? t.lastAccessed : Date.now(),
    incognito: !!t.incognito,
    index: typeof t.index === 'number' ? t.index : 0,
    groupId: typeof t.groupId === 'number' ? t.groupId : -1,
    groupTitle: typeof t.groupTitle === 'string' ? String(t.groupTitle).slice(0, 500) : '',
    groupColor: typeof t.groupColor === 'string' ? String(t.groupColor).slice(0, 100) : '',
    discarded: !!t.discarded,
  }));
}

function safeHostname(urlStr) {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return '*';
  }
}

function baseDomain(hostname) {
  if (!hostname || hostname === '*') return hostname;
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return hostname;
  const sld = parts[parts.length - 2];
  if (['co', 'com', 'org', 'net', 'edu', 'gov', 'ac', 'ne'].includes(sld) && parts.length > 2) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

function nowISO() {
  return new Date().toISOString();
}

function nowEpoch() {
  return Date.now();
}

module.exports = {
  BROWSERS,
  generateMessageId,
  cookieIdentity,
  validateMessage,
  validateRegister,
  validateTab,
  validateTabsArray,
  safeHostname,
  baseDomain,
  nowISO,
  nowEpoch,
};
