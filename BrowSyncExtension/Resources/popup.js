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

// ─── Safari Detection & i18n ──────────────────────────────────────────────────

const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
if (isSafari) {
  document.getElementById('openApp')?.setAttribute('data-i18n', 'btnOpenApp');
}

document.querySelectorAll('[data-i18n]').forEach(el => {
  const message = chrome.i18n.getMessage(el.getAttribute('data-i18n'));
  if (message) el.textContent = message;
});

// ─── Open app ────────────────────────────────────────────────────────────────

document.getElementById('openApp')?.addEventListener('click', () => {
  if (isSafari) {
    chrome.runtime.sendNativeMessage("application.id", { action: "openApp" }, (response) => {});
  } else {
    window.open('http://browsync.ct106.com/', '_blank');
  }
});
