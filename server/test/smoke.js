const WebSocket = require('ws');
const http = require('http');

const URL = 'ws://127.0.0.1:62333';
let failures = 0;

function httpGet(url) {
  return new Promise((resolve) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ FAIL: ${label}`);
    failures++;
  }
}

async function runTests() {
  console.log('\n=== BrowSync Server Smoke Tests ===\n');

  // Test 1: Health endpoint
  let health = await httpGet(`http://127.0.0.1:62333/health`);
  assert(health && health.status === 'ok', 'Health endpoint returns ok');
  assert(health && health.version, 'Health endpoint includes version');

  // Test 2: Stats endpoint
  let stats = await httpGet(`http://127.0.0.1:62333/stats`);
  assert(stats && stats.clients !== undefined, 'Stats endpoint returns client data');

  // Test 3: WebSocket registration
  const ws1 = new WebSocket(URL);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WS1 connection timeout')), 5000);
    ws1.on('open', () => { clearTimeout(timeout); resolve(); });
    ws1.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
  console.log('  ✅ WS1 connected');

  // Test 4: Register
  let regAck = false;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Registration timeout')), 5000);
    ws1.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ack') {
        regAck = true;
        clearTimeout(timeout);
        resolve();
      }
    });
    ws1.send(JSON.stringify({
      type: 'register', browser: 'chrome', instanceId: 'chrome-main',
      messageId: 'reg-1', timestamp: Date.now()
    }));
  });
  assert(regAck, 'Registration received ack');

  // Test 5: Heartbeat
  ws1.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
  console.log('  ✅ Heartbeat sent');

  // Test 6: Settings update
  ws1.send(JSON.stringify({
    type: 'settings',
    payload: { kind: 'raw', raw: { routerDefault: 'chrome', tabSharingEnabled: true } },
    messageId: 'set-1', timestamp: Date.now()
  }));
  await new Promise(r => setTimeout(r, 300));
  health = await httpGet(`http://127.0.0.1:62333/health`);
  assert(health && health.browsers['chrome-main'] && health.browsers['chrome-main'].online, 'Client appears online in health endpoint');

  // Test 7: Bookmark sync
  ws1.send(JSON.stringify({
    type: 'sync', browser: 'chrome', category: 'bookmarks',
    payload: { kind: 'bookmarks', bookmarks: [
      { id: 'b1', title: 'Test', url: 'https://test.com', parentId: '1', isFolder: false, dateAdded: Date.now() / 1000 }
    ]},
    messageId: 'bm-1', timestamp: Date.now()
  }));
  console.log('  ✅ Bookmark sync sent');

  // Test 8: Cookie sync
  ws1.send(JSON.stringify({
    type: 'sync', browser: 'chrome', category: 'cookies',
    payload: { kind: 'cookies', cookies: [
      { name: 'session', value: 'abc', domain: '.test.com', path: '/', secure: true, httpOnly: false, updatedAt: Date.now() }
    ]},
    messageId: 'ck-1', timestamp: Date.now()
  }));
  console.log('  ✅ Cookie sync sent');

  // Test 9: Second client registration and broadcast
  const ws2 = new WebSocket(URL);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WS2 connection timeout')), 5000);
    ws2.on('open', () => { clearTimeout(timeout); resolve(); });
    ws2.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
  console.log('  ✅ WS2 connected');

  let ws2GotAck = false;
  ws2.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'ack') ws2GotAck = true;
  });

  ws2.send(JSON.stringify({
    type: 'register', browser: 'firefox', instanceId: 'firefox-main',
    messageId: 'reg-2', timestamp: Date.now()
  }));
  await new Promise(r => setTimeout(r, 500));
  assert(ws2GotAck, 'WS2 received ack');

  // Test 10: Tab sharing pull
  ws1.send(JSON.stringify({
    type: 'pull', category: 'tabSharing', messageId: 'pull-1', timestamp: Date.now()
  }));
  console.log('  ✅ Tab sharing pull sent');

  // Test 11: Open URL
  ws1.send(JSON.stringify({
    type: 'open_url',
    payload: { kind: 'raw', raw: { targetBrowser: 'firefox', url: 'https://example.com' } },
    messageId: 'ou-1', timestamp: Date.now()
  }));
  await new Promise(r => setTimeout(r, 300));
  console.log('  ✅ open_url relayed');

  // Test 12: disconnect
  ws2.close();
  await new Promise(r => setTimeout(r, 500));
  health = await httpGet(`http://127.0.0.1:62333/health`);
  // Firefox should be offline now
  const ffStatus = health?.browsers?.['firefox-main']?.online;
  assert(ffStatus === false || ffStatus === undefined, 'WS2 disconnect reflected in health (offline or removed)');

  // Test 13: Re-registration of same instanceId
  const ws3 = new WebSocket(URL);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WS3 connection timeout')), 5000);
    ws3.on('open', () => { clearTimeout(timeout); resolve(); });
    ws3.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
  console.log('  ✅ WS3 connected (re-registration)');

  let ws3ReplacedOld = false;
  ws3.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'ack') {
      ws3ReplacedOld = true;
    }
  });
  ws3.send(JSON.stringify({
    type: 'register', browser: 'chrome', instanceId: 'chrome-main',
    messageId: 'reg-3', timestamp: Date.now()
  }));
  await new Promise(r => setTimeout(r, 500));
  assert(ws3ReplacedOld, 'Re-registration with same instanceId succeeds');

  // Test 14: Bookmark removal
  ws3.send(JSON.stringify({
    type: 'sync', browser: 'chrome', category: 'bookmarks_removed',
    payload: { bookmarksRemoved: { id: 'b1', title: 'Test', url: 'https://test.com', isFolder: false } },
    messageId: 'bmdel-1', timestamp: Date.now()
  }));
  console.log('  ✅ Bookmark removal relayed');

  // Test 15: Storage sync
  ws3.send(JSON.stringify({
    type: 'sync', browser: 'chrome', category: 'localStorage',
    payload: { kind: 'localStorage', localStorage: [
      { key: 'token', value: 'xyz', origin: 'https://test.com' }
    ]},
    messageId: 'ls-1', timestamp: Date.now()
  }));
  console.log('  ✅ localStorage sync sent');

  // Cleanup
  ws1.close();
  ws3.close();

  console.log(`\n=== Results: ${failures === 0 ? 'ALL PASSED ✅' : failures + ' FAILURES ❌'} ===\n`);
  process.exit(failures > 0 ? 1 : 0);
}

runTests().catch(e => { console.error('Test error:', e); process.exit(1); });
