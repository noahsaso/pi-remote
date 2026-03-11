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
}

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
