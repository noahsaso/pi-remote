# @noahsaso/pi-remote

Remote terminal access for pi via WebSocket with Tailscale integration. Connect to your pi session from mobile browsers over LAN or your tailnet.

## Features

- **PTY-based remote access** - Wraps pi in a pseudo-terminal for optimal performance
- **WebSocket bridge** - Real-time bidirectional terminal I/O with auto-reconnect and output replay buffer
- **Mobile-first** - Touch scroll with momentum, virtual keybar (arrows, Ctrl+C, etc.)
- **Token authentication** - All connections require token auth (HTTP, WebSocket, API)
- **Auth modal** - Browser prompts for token if missing/invalid, with error feedback on retry
- **QR code** - Prints in the launching terminal, appears in the browser overlay, and is reposted in pi chat output for easy mobile scan
- **`/remote` command** - Restart pi in remote mode from within a running session
- **Tailscale integration** - Automatically serves over HTTPS on your tailnet with a unique session subpath
- **Discovery service** - Lists all active remote sessions at `/pi/` with a card UI; auto-starts on first session, auto-shuts down on last
- **TUI widget** - Optional remote info widget (hidden by default, toggle with `/remote:widget`) plus QR code rendered as chat output
- **Session ended overlay** - Browser shows a modal when the remote session exits
- **Scroll-to-bottom button** - Appears in the header when scrolled up
- **Styled error pages** - Dark themed 403/404 pages matching the app style

## Screenshots

### Browser — Remote access modal
<img src="https://raw.githubusercontent.com/noahsaso/pi-remote/main/packages/remote/docs/remote-access-modal.png" width="360" alt="Remote access modal" />

### TUI — Widget with Tailscale, LAN, and Token
![TUI widget](https://raw.githubusercontent.com/noahsaso/pi-remote/main/packages/remote/docs/tui-widget.png)

## Usage as a pi Extension

This package is primarily used as a [pi coding agent](https://github.com/badlogic/pi-mono) extension. The extension registers a `/remote` command that lets you switch your current pi session into remote access mode without losing context.

### Global (all projects)

Add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "~/path/to/pi-remote/packages/remote"
  ]
}
```

Or install from npm:

```bash
pi install npm:@noahsaso/pi-remote
```

### Project-local

Add to `.pi/settings.json` in your project root:

```json
{
  "extensions": [
    "~/path/to/pi-remote/packages/remote"
  ]
}
```

### Temporary (one-off)

```bash
pi -e ~/path/to/pi-remote/packages/remote/extension/index.ts
```

### Using `/remote` inside pi

Once the extension is loaded, run `/remote` in pi:

```
/remote
/remote https://example.com/demo
```

This will:
1. Save your current session
2. Shut down the current pi process
3. Restart pi wrapped in a PTY with a WebSocket server
4. Print the real session URL + QR code in the launching terminal
5. Post a QR code in pi chat output once the remote session starts

If you pass a URL argument, that URL is used only for the in-session chat QR code (useful for demos), while the actual remote session still uses the real LAN/Tailscale URL shown in the launching terminal.

When running inside a remote session, the compact remote info widget is hidden by default and can be toggled with `/remote:widget`.

---

## Usage as a CLI Tool

You can also launch remote mode directly from the terminal without a running pi session:

```bash
npm install -g @noahsaso/pi-remote
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

# Run only the discovery service (persistent daemon mode)
pi-remote --discovery

# Check discovery service status (sessions, discovery page URL)
pi-remote --status
```

---

## Architecture

```
                        ┌──────────────────┐
                        │  Discovery Svc   │  port 7008
                        │  /pi/ (session   │  Tailscale: /pi/
                        │   list + links)  │
                        └──────────────────┘
                               ▲
              register/deregister via localhost API
                               │
┌─────────────┐         ┌─────────────┐
│   Browser   │  WS     │ HTTP Server │  port 7009+
│  (xterm.js) │────────▶│   + WS      │  Tailscale: /pi/{id}/
└─────────────┘         └──────┬──────┘
                               │
                        ┌──────┴──────┐
                        │     PTY     │
                        │   (pi CLI)  │
                        └─────────────┘
```

### Source Layout

| Path | Description |
|------|-------------|
| `extension/index.ts` | Pi extension entry — registers `/remote`, `/remote:widget`, an optional TUI widget, and QR chat output |
| `src/cli.ts` | `pi-remote` binary entry point |
| `src/discovery.ts` | Discovery service — session registry, card-based web UI, auto-shutdown |
| `src/discovery-main.ts` | Entry point for the detached discovery process |
| `src/tailscale.ts` | Shared Tailscale helpers (find binary, hostname, serve, serve off) |
| `src/pty.ts` | PTY management (node-pty), stdin/stdout attachment |
| `src/ws.ts` | WebSocket bridge, mobile-priority resize logic |
| `src/server.ts` | HTTP server with token auth, `/api/local-url` endpoint, styled error pages |
| `web/` | Browser frontend (xterm.js, touch scroll, virtual keybar, auth modal, session ended overlay) |

---

## API

### `startRemote(options)`

```typescript
import { startRemote } from "@noahsaso/pi-remote";

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
| `PI_REMOTE_DISCOVERY_URL` | Set automatically when the discovery service is running; links to the all-sessions page |

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

## Discovery Service

When multiple remote sessions run on the same machine, the discovery service provides a central landing page listing all active sessions.

- **Auto-start**: The first pi-remote session spawns the discovery service as a detached background process on port `7008`
- **Shared token**: The discovery service generates the auth token; all sessions use the same token
- **Session registry**: Sessions register on startup and deregister on exit via localhost API
- **Web UI**: Card layout at `/pi/` showing each session's working directory and start time, with clickable links
- **Tailscale route**: Served at `https://your-host.tailnet.ts.net/pi/?token=...`
- **Auto-shutdown**: When the last session deregisters, the discovery service cleans up its Tailscale route and exits
- **Spawn button**: The discovery page includes a "+ New Session" button to start new sessions remotely (max 10 concurrent)

**URL structure on tailnet:**
- `https://host.ts.net/pi/?token=...` → discovery service (all sessions)
- `https://host.ts.net/pi/abc12345/?token=...` → individual session

### Persistent Discovery Daemon

By default, the discovery service auto-exits when the last session deregisters. To keep it running permanently (so the "+ New Session" button on the discovery page is always available), use the `--discovery` flag:

```bash
pi-remote --discovery
```

This runs only the discovery service in persistent mode — no PTY session is spawned. The discovery page at `/pi/` stays available and includes a "+ New Session" button that spawns new headless pi-remote sessions.

#### systemd Setup

To run the discovery service as a system service on Linux:

1. Create `/etc/systemd/system/pi-remote-discovery.service`:

```ini
[Unit]
Description=pi-remote discovery service
After=network.target tailscaled.service

[Service]
ExecStart=/usr/local/bin/pi-remote --discovery
Restart=on-failure
RestartSec=5
User=YOUR_USERNAME
Environment=HOME=/home/YOUR_USERNAME
WorkingDirectory=/home/YOUR_USERNAME

[Install]
WantedBy=multi-user.target
```

2. Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable pi-remote-discovery
sudo systemctl start pi-remote-discovery
```

3. Check status:

```bash
sudo systemctl status pi-remote-discovery
journalctl -u pi-remote-discovery -f
```

## Security

- **Shared token** — Single random 16-byte token generated by the discovery service, shared across all sessions. Required for all connections (HTTP API, WebSocket, pages). Static assets and the SPA shell are exempt so the auth modal can load.
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
