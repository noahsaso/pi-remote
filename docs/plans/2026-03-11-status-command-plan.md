# `pi-remote --status` Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `--status` flag that queries the discovery service and prints its status.

**Architecture:** Parse `--status` in `cli.ts` before the existing `--discovery` check. Hit `localhost:7008` APIs, resolve Tailscale hostname locally, print formatted output, exit.

**Tech Stack:** Node.js, existing discovery HTTP API, existing tailscale utilities.

---

### Task 1: Add --status flag to cli.ts

**Files:**
- Modify: `packages/remote/src/cli.ts`

**Step 1: Add the --status parsing block**

Insert before the `--discovery` check in `cli.ts`. The full file should become:

```ts
#!/usr/bin/env node
/**
 * pi-remote CLI entry point.
 *
 * Usage:
 *   pi-remote [-- <pi-args...>]
 *   pi-remote --pi-path /custom/pi [-- <pi-args...>]
 *   pi-remote --discovery          # run only the persistent discovery service
 *   pi-remote --status             # check discovery service status
 */

import { startRemote } from "./index.js";

const argv = process.argv.slice(2);

// Parse --status (check discovery service status and exit)
const statusIdx = argv.indexOf("--status");
if (statusIdx !== -1) {
	const { DISCOVERY_PORT } = await import("./discovery.js");
	const { findTailscaleBin, getTailscaleHostname } = await import("./tailscale.js");

	const base = `http://127.0.0.1:${DISCOVERY_PORT}`;

	// Check if discovery service is reachable
	let token: string | null = null;
	try {
		const res = await fetch(`${base}/api/token`);
		if (res.ok) {
			const data = (await res.json()) as { token: string };
			token = data.token;
		}
	} catch {
		// not reachable
	}

	if (!token) {
		process.stderr.write("Discovery service: not running\n");
		process.exit(1);
	}

	// Build discovery page URL
	let pageUrl = `http://127.0.0.1:${DISCOVERY_PORT}/?token=${token}`;
	const tsBin = findTailscaleBin();
	if (tsBin) {
		const hostname = getTailscaleHostname(tsBin);
		if (hostname) {
			pageUrl = `https://${hostname}/pi/?token=${token}`;
		}
	}

	process.stderr.write(`Discovery service: running\n`);
	process.stderr.write(`Discovery page:    ${pageUrl}\n`);

	// Fetch sessions
	try {
		const res = await fetch(`${base}/api/sessions`);
		if (res.ok) {
			const data = (await res.json()) as {
				sessions: Array<{ sessionId: string; port: number; cwd: string; startedAt: string }>;
			};
			const sessions = data.sessions;
			if (sessions.length === 0) {
				process.stderr.write("\nNo active sessions\n");
			} else {
				process.stderr.write(`\nSessions (${sessions.length}):\n`);
				for (const s of sessions) {
					const ago = formatAge(s.startedAt);
					process.stderr.write(`  • ${s.cwd}  (${ago})\n`);
				}
			}
		}
	} catch {
		// sessions endpoint failed, skip
	}

	process.exit(0);
} else
// Parse --discovery (run persistent discovery service only)
// ... rest of existing code unchanged
```

The `formatAge` helper (add at the bottom of cli.ts or inline before usage):

```ts
function formatAge(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime();
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}
```

**Step 2: Verify it compiles**

Run: `cd packages/remote && npx tsc --noEmit`
Expected: no errors

**Step 3: Manual test**

Run without discovery service running:
```bash
node packages/remote/dist/cli.js --status
```
Expected: prints "Discovery service: not running", exits with code 1.

Run with discovery service running:
```bash
node packages/remote/dist/cli.js --discovery &
sleep 1
node packages/remote/dist/cli.js --status
```
Expected: prints status with discovery page URL and session info.

**Step 4: Commit**

```bash
git add packages/remote/src/cli.ts
git commit -m "feat(cli): add --status flag to check discovery service"
```

### Task 2: Update README

**Files:**
- Modify: `packages/remote/README.md`

**Step 1: Add --status to usage section**

Add a row/section documenting the `--status` flag alongside `--discovery`.

**Step 2: Commit**

```bash
git add packages/remote/README.md
git commit -m "docs: add --status flag to README"
```
