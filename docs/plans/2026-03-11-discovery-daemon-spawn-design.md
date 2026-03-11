# Discovery Daemon + Session Spawning

## Problem

The discovery service auto-exits 500ms after the last session deregisters. With no server running, there's no UI to spawn new sessions remotely. Users need the discovery page available 24/7 so they can create sessions from a browser without SSH-ing into the machine first.

## Design

### 1. CLI: `--discovery` flag (`src/cli.ts`)

Add a `--discovery` flag to the existing `pi-remote` command:

```
pi-remote                  # normal: spawn PTY session + register with discovery
pi-remote --discovery      # daemon: run only the discovery service, no PTY
```

When `--discovery` is present, call `startDiscoveryService(true)` (persistent mode) and return. No PTY is spawned.

### 2. Persistent discovery mode (`src/discovery.ts`)

Change `startDiscoveryService` signature to accept a `persistent` flag:

```ts
export function startDiscoveryService(persistent?: boolean): Promise<void>
```

When `persistent` is true, the DELETE `/api/sessions/:id` handler skips the `setTimeout(shutdown, 500)` auto-shutdown logic. The service runs until explicitly killed.

Existing behavior (auto-shutdown when empty) is preserved when `persistent` is false/omitted, so normal `pi-remote` usage is unchanged.

### 3. Spawn endpoint (`src/discovery.ts`)

Add `POST /api/spawn` — token-authed (same as the web UI), not restricted to localhost.

- **Auth:** Require `?token=...` matching the discovery token. Return 403 if invalid.
- **Session cap:** If `sessions.size >= 10`, return 429 with a message.
- **Spawn:** Run `node cli.js` as a detached child process with `stdio: "ignore"` and `cwd: os.homedir()`. The spawned process has no TTY, so `process.stdin.isTTY` is undefined and `attachLocal` in `spawnInPty` naturally stays off. The new session self-registers with the discovery service via the normal flow.
- **Response:** Return `{ ok: true }`. The client refreshes the page after a short delay to see the new session.

`cli.js` is located as a sibling file relative to `discovery.ts` in `dist/`.

### 4. "+ New Session" card in discovery HTML

Add a card styled consistently with session cards that POSTs to `/api/spawn?token=...` via JavaScript. On success, wait ~2 seconds and reload the page so the new session appears in the list.

### 5. README: systemd documentation

Document the `--discovery` flag and provide a systemd unit example:

```ini
[Unit]
Description=pi-remote discovery service
After=network.target tailscaled.service

[Service]
ExecStart=/path/to/pi-remote --discovery
Restart=on-failure
User=<your-user>

[Install]
WantedBy=multi-user.target
```

## Files Changed

| File | Change |
|---|---|
| `src/cli.ts` | Parse `--discovery`, call `startDiscoveryService(true)` |
| `src/discovery.ts` | Add `persistent` param, `POST /api/spawn`, `+ New Session` card |
| `README.md` | Document `--discovery` flag and systemd setup |

## What's NOT changing

- `src/index.ts` — no changes to `RemoteOptions` or `startRemote`
- `src/pty.ts` — no changes needed
- No new CLI flags beyond `--discovery`
- Auto-shutdown behavior preserved for normal (non-daemon) usage
