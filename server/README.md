# BrowSync Remote Server

A Node.js WebSocket server that replaces the macOS daemon in BrowSync, enabling cross-browser sync to work over the internet — no local app required.

## Quick Start

```bash
cd server
npm install
npm start
```

Server runs on `ws://0.0.0.0:62333` by default.

## Configuration

All config via environment variables or `src/config.js`:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `62333` | WebSocket + HTTP port |
| `HOST` | `0.0.0.0` | Listen address |
| `DATA_DIR` | `./data` | SQLite database location |
| `BROWSYNC_AUTH_TOKEN` | (none) | Set to enable authentication |

## Authentication

Set `BROWSYNC_AUTH_TOKEN` to a secure random string. Extensions must then include `"authToken"` in their `register` message:

```json
{
  "type": "register",
  "browser": "chrome",
  "instanceId": "chrome-main",
  "authToken": "your-secret-token"
}
```

Without a token set, the server runs in open mode (suitable for local/trusted networks).

## Extending Extensions to Use This Server

1. Change `DAEMON_URL` in the extension's service-worker.js:
   ```js
   const DAEMON_URL = 'wss://your-server.com:62333';
   ```

2. Add auth token to the register message:
   ```js
   send({ type: 'register', browser: DETECTED_BROWSER, instanceId: INSTANCE_ID, authToken: 'your-token' });
   ```

3. For production, use `wss://` with TLS (add a reverse proxy like nginx or Caddy).

## Docker

```bash
docker compose up -d
```

Or standalone:

```bash
docker build -t browsync-server .
docker run -d -p 62333:62333 -v browsync_data:/app/data browsync-server
```

## HTTP Endpoints

| Path | Description |
|------|-------------|
| `/health` | Health check with browser status |
| `/stats` | Detailed statistics |
| `/logs` | Recent sync log entries |

## Protocol

Full protocol compatibility with BrowSync macOS app v1.1.2:

- **register** — Client announces browser + instanceId
- **heartbeat** — 30s keepalive, 120s timeout
- **sync** — Push bookmarks, cookies, localStorage, sessionStorage, tabs
- **pull** — Request data from other browsers, with category/site filters
- **ack** — Message acknowledgment
- **settings** — Broadcast/update app settings
- **open_settings** — Open settings (no-op in remote mode)
- **open_url** — Route URL to specific browser
- **error** / **disconnect**

Conflict resolution: latest-wins by default with cookie tombstones. Configurable per-site strategy. Resurrection detection for cookies that reappear.
