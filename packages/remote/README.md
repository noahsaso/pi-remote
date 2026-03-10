# @q.roy/pi-remote

Remote terminal access for pi via WebSocket. Connect to your pi session from mobile browsers over LAN.

## Features

- **PTY-based remote access** - Wraps pi in a pseudo-terminal for optimal performance
- **WebSocket bridge** - Real-time bidirectional terminal I/O with auto-reconnect and output replay buffer
- **Mobile-first** - Touch scroll with momentum, virtual keybar (arrows, Ctrl+C, etc.)
- **Token authentication** - All connections require token auth (HTTP, WebSocket, API)
- **Auth modal** - Browser prompts for token if missing/invalid, with error feedback on retry
- **QR code** - Scan to connect instantly from mobile
- **`/remote` command** - Restart pi in remote mode from within a running session
- **Tailscale integration** - Automatically serves over HTTPS on your tailnet with a unique session subpath
- **TUI widget** - Shows Tailscale URL, LAN URL, and token in a bordered card above the editor
- **Session ended overlay** - Browser shows a modal when the remote session exits
- **Scroll-to-bottom button** - Appears in the header when scrolled up
- **Styled error pages** - Dark themed 403/404 pages matching the app style

## Usage as a pi Extension

This package is primarily used as a [pi coding agent](https://github.com/badlogic/pi-mono) extension. The extension registers a `/remote` command that lets you switch your current pi session into remote access mode without losing context.

### Global (all projects)

Add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "~/path/to/pi-mono-extensions/packages/remote"
  ]
}
```

Or install from npm and reference the package:

```json
{
  "packages": ["@q.roy/pi-remote"]
}
```

### Project-local

Add to `.pi/settings.json` in your project root:

```json
{
  "extensions": [
    "~/path/to/pi-mono-extensions/packages/remote"
  ]
}
```

### Temporary (one-off)

```bash
pi -e ~/path/to/pi-mono-extensions/packages/remote/extension/index.ts
```

### Using `/remote` inside pi

Once the extension is loaded, run `/remote` in pi:

```
/remote
```

This will:
1. Save your current session
2. Shut down the current pi process
3. Restart pi wrapped in a PTY with a WebSocket server
4. Display a QR code and URL — scan from mobile or open in a browser

When running inside a remote session, a persistent widget above the editor shows the remote URL.

---

## Usage as a CLI Tool

You can also launch remote mode directly from the terminal without a running pi session:

```bash
npm install -g @q.roy/pi-remote
pi-remote
```

### Options

```bash
# Specify a custom pi binary path
pi-remote --pi-path /path/to/pi

# Pass extra arguments to pi
pi-remote -- --continue

# Custom port (default: 7009)
PORT=8080 pi-remote
```

---

## Architecture

```
┌─────────────┐
│   Browser   │  (mobile / desktop)
│  (xterm.js) │
└──────┬──────┘
       │ WebSocket
       ▼
┌─────────────┐
│ HTTP Server │  (token auth, static files)
│   + WS      │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│     PTY     │  (node-pty)
│   (pi CLI)  │
└─────────────┘
```

### Source Layout

| Path | Description |
|------|-------------|
| `extension/index.ts` | Pi extension entry — registers `/remote` command and bordered TUI widget (Tailscale, LAN, Token) |
| `src/cli.ts` | `pi-remote` binary entry point |
| `src/pty.ts` | PTY management (node-pty), stdin/stdout attachment |
| `src/ws.ts` | WebSocket bridge, mobile-priority resize logic |
| `src/server.ts` | HTTP server with token auth, `/api/local-url` endpoint, styled error pages |
| `web/` | Browser frontend (xterm.js, touch scroll, virtual keybar, auth modal, session ended overlay) |

---

## API

### `startRemote(options)`

```typescript
import { startRemote } from "@q.roy/pi-remote";

const cleanup = await startRemote({
  piPath: "/usr/local/bin/pi",  // optional, auto-detected
  args: ["--continue"],          // optional, passed to pi
  cwd: process.cwd(),            // optional
  env: process.env,              // optional
});

// Stop the server and kill the PTY process
cleanup();
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP server port (default: `7009`) |
| `PI_REMOTE_URL` | Set automatically when running inside `pi-remote`; the extension uses this to show the URL widget |
| `PI_REMOTE_TAILSCALE_URL` | Set automatically when Tailscale serve is active; shown in the TUI widget |

---

## Tailscale Integration

When [Tailscale](https://tailscale.com) is installed and running, pi-remote automatically:

1. Detects the Tailscale binary (checks PATH, then known locations for macOS/Linux)
2. Gets the machine's Tailscale hostname via `tailscale status --json`
3. Runs `tailscale serve --bg --https 443 --set-path /pi/{session-id}/ http://localhost:{port}`
4. Displays the full URL with auth token: `https://your-host.tailnet.ts.net/pi/abc123/?token=...`
5. Shows the Tailscale URL in the QR code modal (with LAN URL as fallback)
6. Cleans up the specific serve route on exit (without affecting other `tailscale serve` routes)

**Graceful fallback:** If Tailscale is not installed, not running, or the serve command fails, pi-remote continues normally with just the LAN URL. No errors are shown.

**Multiple sessions:** Each session gets a unique `/pi/{8-hex-chars}/` subpath, so multiple remote sessions can coexist on the same machine.

## Security

- **Token-based auth** — Random 16-byte token required for all connections (HTTP API, WebSocket, pages). Static assets and the SPA shell are exempt so the auth modal can load.
- **No localhost exemption** — Even connections from `127.0.0.1` (including Tailscale proxy) require a valid token
- **Auth modal** — If the browser doesn't have a valid token, a login modal prompts for one
- **Styled error pages** — Invalid tokens show a dark-themed "Access denied" page; bad paths show "No session found"
- **Tailscale** — When using Tailscale, traffic is encrypted end-to-end within your tailnet using auto-provisioned TLS certificates

---

## Development

```bash
# Install dependencies (from monorepo root)
npm install

# Build TypeScript
npm run build:ts

# Build web UI
npm run build:web

# Full build
npm run build

# Watch mode (TypeScript only)
npm run dev

# Link globally for testing
npm link
```

---

## License

MIT
