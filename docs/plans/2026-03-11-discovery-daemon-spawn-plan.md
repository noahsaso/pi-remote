# Discovery Daemon + Session Spawning — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `--discovery` flag to run the discovery service as a persistent daemon, and a `POST /api/spawn` endpoint with a "+ New Session" button so users can create new pi sessions from the browser.

**Architecture:** The `--discovery` flag makes `cli.ts` call `startDiscoveryService(true)` which skips auto-shutdown on empty. The spawn endpoint runs `node cli.js` as a detached process (no TTY → no local attach). The discovery HTML gets a new card that POSTs to `/api/spawn` and refreshes.

**Tech Stack:** Node.js, node-pty (existing), child_process.spawn (existing pattern in index.ts)

---

### Task 1: Add persistent mode to discovery service

**Files:**
- Modify: `packages/remote/src/discovery.ts`

**Step 1: Add `persistent` parameter to `startDiscoveryService`**

In `packages/remote/src/discovery.ts`, change the function signature:

```ts
export function startDiscoveryService(persistent = false): Promise<void> {
```

**Step 2: Store persistent flag and guard the auto-shutdown**

Add a module-level variable near the top (after `const TOKEN = ...`):

```ts
let persistentMode = false;
```

At the start of `startDiscoveryService`, set it:

```ts
persistentMode = persistent;
```

In `handleRequest`, find the DELETE handler block containing:

```ts
// Shut down if no sessions remain
if (sessions.size === 0) setTimeout(shutdown, 500);
```

Change it to:

```ts
// Shut down if no sessions remain (unless running in persistent mode)
if (sessions.size === 0 && !persistentMode) setTimeout(shutdown, 500);
```

**Step 3: Commit**

```bash
git add packages/remote/src/discovery.ts
git commit -m "feat(discovery): add persistent mode to skip auto-shutdown"
```

---

### Task 2: Add `POST /api/spawn` endpoint

**Files:**
- Modify: `packages/remote/src/discovery.ts`

**Step 1: Add imports**

At the top of `packages/remote/src/discovery.ts`, add `homedir` to the `node:os` import (there isn't one yet) and `spawn` from `child_process`, and `join`/`dirname`/`fileURLToPath` for resolving `cli.js`:

```ts
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
```

Add after the existing imports, near the top constants:

```ts
const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_SESSIONS = 10;
```

**Step 2: Add the spawn endpoint to `handleRequest`**

In the `handleRequest` function, add a new handler block **before** the "Web UI: token-authed" section (the `url === "/"` check). This endpoint is token-authed but NOT localhost-restricted, so it goes after the localhost-only API block:

```ts
	// Token-authed API (accessible remotely)
	if (url === "/api/spawn" && method === "POST") {
		const urlToken = parsedUrl.searchParams.get("token");
		if (urlToken !== TOKEN) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Invalid or missing access token" }));
			return;
		}
		if (sessions.size >= MAX_SESSIONS) {
			res.writeHead(429, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: `Session limit reached (${MAX_SESSIONS})` }));
			return;
		}
		const cliPath = join(__dirname, "cli.js");
		const child = spawn(process.execPath, [cliPath], {
			detached: true,
			stdio: "ignore",
			cwd: homedir(),
		});
		child.unref();
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
		return;
	}
```

**Step 3: Commit**

```bash
git add packages/remote/src/discovery.ts
git commit -m "feat(discovery): add POST /api/spawn endpoint with session cap"
```

---

### Task 3: Add "+ New Session" card to discovery HTML

**Files:**
- Modify: `packages/remote/src/discovery.ts`

**Step 1: Add the card and JavaScript to `renderPage()`**

In the `renderPage()` function, add a "+ New Session" card after the session cards. Find the line:

```ts
	return `<!doctype html>
```

Replace the entire `renderPage()` function body with the version below. The key additions are: (a) a `new-session` card with a `+` icon, (b) inline JS that POSTs to `/api/spawn` and reloads after 2 seconds, (c) CSS for the new card:

In the `<style>` block, add these rules after the existing `.empty` rule:

```css
.new-session{display:flex;align-items:center;justify-content:center;gap:8px;background:#1a1a1a;border:1px dashed #444;border-radius:10px;padding:16px 20px;margin-bottom:12px;cursor:pointer;color:#888;font-size:14px;transition:border-color 0.15s,color 0.15s;text-decoration:none}
.new-session:hover{border-color:#666;color:#ccc}
.new-session.spawning{pointer-events:none;opacity:0.5}
```

After `${cardsHtml}`, add the new session card and script:

```html
<div class="new-session" id="spawn-btn" onclick="spawnSession()">+ New Session</div>
<script>
function spawnSession(){
  var btn=document.getElementById('spawn-btn');
  btn.classList.add('spawning');
  btn.textContent='Starting…';
  fetch('/api/spawn?token=${TOKEN}',{method:'POST'})
    .then(function(r){return r.json()})
    .then(function(d){
      if(d.ok){setTimeout(function(){location.reload()},2500)}
      else{btn.textContent=d.error||'Error';btn.classList.remove('spawning')}
    })
    .catch(function(){btn.textContent='Failed';btn.classList.remove('spawning')});
}
</script>
```

Here's the complete updated `renderPage()` for clarity:

```ts
function renderPage(): string {
	const baseUrl = tailscaleUrl ? `https://${tsHostname}` : `http://127.0.0.1:${DISCOVERY_PORT}`;
	const sessionList = Array.from(sessions.values()).sort(
		(a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
	);

	const cardsHtml =
		sessionList.length > 0
			? sessionList.map((s) => sessionCard(s, baseUrl, TOKEN)).join("\n")
			: '<div class="empty">No active sessions</div>';

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>pi remote</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:#0a0a0a;color:#d4d4d4;font-family:system-ui,sans-serif}
body{display:flex;align-items:center;justify-content:center;padding:20px}
.container{max-width:400px;width:100%}
h1{font-size:18px;color:#e0e0e0;margin-bottom:16px;text-align:center}
.card{display:block;background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:16px 20px;margin-bottom:12px;text-decoration:none;color:inherit;transition:border-color 0.15s}
.card:hover{border-color:#555}
.cwd{font-size:14px;color:#e0e0e0;font-family:ui-monospace,monospace;word-break:break-all}
.meta{font-size:11px;color:#666;margin-top:6px}
.empty{background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:24px 28px;text-align:center;font-size:12px;color:#888}
.new-session{display:flex;align-items:center;justify-content:center;gap:8px;background:#1a1a1a;border:1px dashed #444;border-radius:10px;padding:16px 20px;margin-bottom:12px;cursor:pointer;color:#888;font-size:14px;transition:border-color 0.15s,color 0.15s}
.new-session:hover{border-color:#666;color:#ccc}
.new-session.spawning{pointer-events:none;opacity:0.5}
</style>
</head>
<body>
<div class="container">
<h1>pi remote</h1>
${cardsHtml}
<div class="new-session" id="spawn-btn" onclick="spawnSession()">+ New Session</div>
</div>
<script>
function spawnSession(){
  var btn=document.getElementById('spawn-btn');
  btn.classList.add('spawning');
  btn.textContent='Starting…';
  fetch('/api/spawn?token=${TOKEN}',{method:'POST'})
    .then(function(r){return r.json()})
    .then(function(d){
      if(d.ok){setTimeout(function(){location.reload()},2500)}
      else{btn.textContent=d.error||'Error';btn.classList.remove('spawning')}
    })
    .catch(function(){btn.textContent='Failed';btn.classList.remove('spawning')});
}
</script>
</body>
</html>`;
}
```

**Step 2: Commit**

```bash
git add packages/remote/src/discovery.ts
git commit -m "feat(discovery): add + New Session card to discovery page"
```

---

### Task 4: Add `--discovery` flag to CLI

**Files:**
- Modify: `packages/remote/src/cli.ts`

**Step 1: Parse `--discovery` and call the discovery service**

Replace the entire contents of `packages/remote/src/cli.ts` with:

```ts
#!/usr/bin/env node
/**
 * pi-remote CLI entry point.
 *
 * Usage:
 *   pi-remote [-- <pi-args...>]
 *   pi-remote --pi-path /custom/pi [-- <pi-args...>]
 *   pi-remote --discovery          # run only the persistent discovery service
 */

import { startRemote } from "./index.js";

const argv = process.argv.slice(2);

// Parse --discovery (run persistent discovery service only)
const discoveryIdx = argv.indexOf("--discovery");
if (discoveryIdx !== -1) {
	argv.splice(discoveryIdx, 1);
	const { startDiscoveryService } = await import("./discovery.js");
	await startDiscoveryService(true);
	// Keep the process alive — startDiscoveryService resolves after the server starts listening
	// The process stays alive because the HTTP server holds the event loop open
} else {
	let piPath: string | undefined;
	let extraArgs: string[] = [];

	// Parse --pi-path <path>
	const piPathIdx = argv.indexOf("--pi-path");
	if (piPathIdx !== -1 && piPathIdx + 1 < argv.length) {
		piPath = argv[piPathIdx + 1];
		argv.splice(piPathIdx, 2);
	}

	// Everything after -- is forwarded to pi
	const dashDash = argv.indexOf("--");
	if (dashDash !== -1) {
		extraArgs = argv.slice(dashDash + 1);
	}

	startRemote({ piPath, args: extraArgs }).catch((err) => {
		process.stderr.write(`pi-remote: ${(err as Error).message}\n`);
		process.exit(1);
	});
}
```

**Step 2: Commit**

```bash
git add packages/remote/src/cli.ts
git commit -m "feat(cli): add --discovery flag for persistent daemon mode"
```

---

### Task 5: Update README with `--discovery` docs and systemd example

**Files:**
- Modify: `packages/remote/README.md`

**Step 1: Add `--discovery` to the CLI options section**

In `packages/remote/README.md`, find the "Options" code block under "Usage as a CLI Tool":

```bash
# Specify a custom pi binary path
pi-remote --pi-path /path/to/pi

# Pass extra arguments to pi
pi-remote -- --continue

# Custom port (default: 7009)
PORT=8080 pi-remote
```

Add after the last line:

```bash

# Run only the discovery service (persistent daemon mode)
pi-remote --discovery
```

**Step 2: Add a "Persistent Discovery Daemon" section**

After the existing "Discovery Service" section in the README, add:

```markdown
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
```

**Step 3: Add `+ New Session` mention to the Discovery Service section**

In the existing "Discovery Service" section, find the bullet:

```markdown
- **Auto-shutdown**: When the last session deregisters, the discovery service cleans up its Tailscale route and exits
```

Add after it:

```markdown
- **Spawn button**: The discovery page includes a "+ New Session" button to start new sessions remotely (max 10 concurrent)
```

**Step 4: Add the new env var to the Environment Variables table**

There is no env var to document here (persistent mode uses `--discovery` flag, not an env var). Skip.

**Step 5: Commit**

```bash
git add packages/remote/README.md
git commit -m "docs: add --discovery flag and systemd setup to README"
```

---

### Task 6: Build and verify

**Step 1: Build the project**

```bash
cd /home/exedev/.my-pi/pi-remote
npm run build
```

Expected: Build succeeds with no errors.

**Step 2: Verify `--discovery` flag works**

```bash
cd /home/exedev/.my-pi/pi-remote
timeout 3 node packages/remote/dist/cli.js --discovery 2>&1 || true
```

Expected: Should print discovery service startup message and listen on port 7008. The `timeout` kills it after 3 seconds.

**Step 3: Commit (if any build fixes needed)**

```bash
git add -A
git commit -m "fix: address build issues" --allow-empty
```
