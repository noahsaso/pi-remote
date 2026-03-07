# @q.roy/pi-remote

Remote terminal access for pi via WebSocket. Connect to your pi session from mobile browsers over LAN.

## Features

- **PTY-based remote access** - Wraps pi in a pseudo-terminal for optimal performance
- **WebSocket bridge** - Real-time bidirectional terminal I/O
- **Mobile-first** - Touch scroll with momentum, virtual keybar (arrows, Ctrl+C, etc.)
- **Token authentication** - Secure LAN access with auto-generated tokens
- **QR code** - Scan to connect instantly from mobile
- **Session preservation** - Use `/remote` command in pi to restart in remote mode

## Installation

```bash
npm install -g @q.roy/pi-remote
```

Or use from the monorepo:

```bash
cd packages/remote
npm run build:ts
npm link
```

## Usage

### Start pi in remote mode

```bash
pi-remote
```

This will:
1. Display a QR code and remote URL
2. Start pi in a PTY
3. Serve a web UI on `http://0.0.0.0:7009`

Scan the QR code with your mobile browser or open the URL to access pi remotely.

### From within pi

When pi is already running, use the `/remote` command:

```
/remote
```

This saves your session and restarts pi in remote mode with `--continue` flag.

### Custom options

```bash
# Specify pi path
pi-remote --pi-path /path/to/pi

# Pass arguments to pi
pi-remote -- --model sonnet --continue

# Custom port (default: 7009)
PORT=8080 pi-remote
```

## Architecture

```
┌─────────────┐
│   Browser   │ (mobile/desktop)
│  (xterm.js) │
└──────┬──────┘
       │ WebSocket
       │
┌──────▼──────┐
│ HTTP Server │ (token auth, static files)
│   + WS      │
└──────┬──────┘
       │
┌──────▼──────┐
│     PTY     │ (node-pty)
│   (pi CLI)  │
└─────────────┘
```

### Components

- **`src/pty.ts`** - PTY management with node-pty, local stdin/stdout attachment
- **`src/ws.ts`** - WebSocket bridge with mobile-priority resize logic
- **`src/server.ts`** - HTTP server with token auth, `/api/local-url` endpoint
- **`web/`** - Frontend with xterm.js, mobile touch scroll, virtual keybar
- **`src/cli.ts`** - `pi-remote` binary entry point

## Security

- **Token-based auth**: Random 16-byte token required for remote access
- **Local exempt**: `127.0.0.1` connections don't need token
- **LAN only**: Designed for local network use (not exposed to internet)

## Mobile Features

- **Touch scroll** - Smooth scrolling with momentum/inertia
- **Virtual keybar** - Quick access to: ↑ ↓ ← → Enter Tab Esc Ctrl+C
- **Responsive layout** - 60-column terminal on mobile, full-width on desktop
- **Mobile-priority resize** - Mobile clients override PC resize to prevent garbled display

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

// Later: cleanup to stop server and kill PTY
cleanup();
```

### Environment Variables

- `PORT` - HTTP server port (default: 7009)
- `ANTHROPIC_API_KEY` - Required for pi to work

## Development

```bash
# Build TypeScript
npm run build:ts

# Build web UI
cd web && npm install && npm run build

# Link globally
npm link

# Test
pi-remote
```

## License

MIT
