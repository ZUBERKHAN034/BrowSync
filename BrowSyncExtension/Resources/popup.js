// popup.js — BrowSync extension popup

'use strict';

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

// ─── Connection status ────────────────────────────────────────────────────────

async function updateStatus() {
  const { wsState } = await chrome.storage.local.get('wsState');
  const connected = wsState === 'open';
  
  const { isWorking } = await chrome.storage.local.get('isWorking');
  
  statusDot.classList.remove('connected', 'working');
  if (connected) {
    if (isWorking) {
      statusDot.classList.add('working');
      statusText.textContent = chrome.i18n.getMessage("statusSyncing") || 'Syncing...';
    } else {
      statusDot.classList.add('connected');
      statusText.textContent = chrome.i18n.getMessage("statusConnected") || 'Connected to BrowSync';
    }
  } else {
    statusText.textContent = chrome.i18n.getMessage("statusDisconnected") || 'Disconnected';
  }
}

updateStatus();
setInterval(updateStatus, 1500);

// ─── Settings ─────────────────────────────────────────────────────────────────

const toggleBookmarkSync = document.getElementById('toggleBookmarkSync');
const toggleStateSync = document.getElementById('toggleStateSync');
const btnSetRouterDefault = document.getElementById('btnSetRouterDefault');
const textIsRouterDefault = document.getElementById('textIsRouterDefault');
const btnMoreSettings = document.getElementById('btnMoreSettings');

async function loadSettings() {
  const { appSettings } = await chrome.storage.local.get('appSettings');
  if (!appSettings) return;

  const browserId = navigator.userAgent.toLowerCase().includes('safari') && !navigator.userAgent.toLowerCase().includes('chrome') ? 'safari' : 'chrome';

  const isBookmarkSync = appSettings.bookmarkParticipatingBrowsers?.[browserId] === true;
  const isStateSync = appSettings.stateParticipatingBrowsers?.[browserId] === true;
  const isRouterDefault = appSettings.routerDefault === browserId;

  if (toggleBookmarkSync) toggleBookmarkSync.checked = isBookmarkSync;
  if (toggleStateSync) toggleStateSync.checked = isStateSync;
  
  if (btnSetRouterDefault && textIsRouterDefault) {
    if (isRouterDefault) {
      btnSetRouterDefault.style.display = 'none';
      textIsRouterDefault.style.display = 'inline';
    } else {
      btnSetRouterDefault.style.display = 'inline-block';
      textIsRouterDefault.style.display = 'none';
    }
  }
}

if (toggleBookmarkSync) {
  toggleBookmarkSync.addEventListener('change', (e) => {
    chrome.runtime.sendMessage({ type: 'UPDATE_SETTING', setting: 'bookmarkSync', value: e.target.checked });
  });
}

if (toggleStateSync) {
  toggleStateSync.addEventListener('change', (e) => {
    chrome.runtime.sendMessage({ type: 'UPDATE_SETTING', setting: 'stateSync', value: e.target.checked });
  });
}

if (btnSetRouterDefault) {
  btnSetRouterDefault.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'UPDATE_SETTING', setting: 'routerDefault', value: true });
  });
}

if (btnMoreSettings) {
  btnMoreSettings.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS' });
    window.close();
  });
}

loadSettings();
setInterval(loadSettings, 1000);

// ─── i18n ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const elements = document.querySelectorAll('[data-i18n]');
  elements.forEach(el => {
    const msg = chrome.i18n.getMessage(el.getAttribute('data-i18n'));
    if (msg) el.textContent = msg;
  });
  
  const subtitleEl = document.getElementById('appSubtitle');
  if (subtitleEl) {
    subtitleEl.textContent = 'v' + chrome.runtime.getManifest().version;
  }
});
