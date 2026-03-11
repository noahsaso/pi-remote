/**
 * pi-remote: start pi inside a PTY and expose it over WebSocket for remote
 * browser/mobile access.
 *
 * Usage:
 *   import { startRemote } from "@noahsaso/pi-remote";
 *   await startRemote({ piPath: "/path/to/pi", args: ["-c"] });
 */

import { execSync, spawn } from "node:child_process";
import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DISCOVERY_PORT } from "./discovery.js";
import { killPty, onPtyExit, spawnInPty } from "./pty.js";
import {
	getAccessToken,
	getLocalUrl,
	getPort,
	setAccessToken,
	setTailscaleUrl as setServerTailscaleUrl,
	startServer,
} from "./server.js";
import { findTailscaleBin, getTailscaleHostname, tailscaleServe, tailscaleServeOff } from "./tailscale.js";
import { setupTerminalWebSocket } from "./ws.js";

export { getAccessToken, getLocalUrl, getPort };

const __dirname = dirname(fileURLToPath(import.meta.url));
const DISCOVERY_URL = `http://127.0.0.1:${DISCOVERY_PORT}`;

// ---------- Discovery client ----------

async function fetchDiscovery(path: string, options?: RequestInit): Promise<Response | null> {
	try {
		return await fetch(`${DISCOVERY_URL}${path}`, options);
	} catch {
		return null;
	}
}

async function getDiscoveryToken(): Promise<string | null> {
	const res = await fetchDiscovery("/api/token");
	if (!res?.ok) return null;
	const { token } = (await res.json()) as { token: string };
	return token;
}

async function ensureDiscoveryService(): Promise<string> {
	// Try to reach existing discovery service
	let token = await getDiscoveryToken();
	if (token) {
		process.stderr.write("\x1b[1;32m[discovery]\x1b[0m connected to existing service\n");
		return token;
	}

	// Spawn discovery service as detached process
	const entryPoint = join(__dirname, "discovery-main.js");
	process.stderr.write(`\x1b[1;32m[discovery]\x1b[0m spawning: ${entryPoint}\n`);
	const child = spawn(process.execPath, [entryPoint], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();

	// Poll until ready (max 5 seconds)
	for (let i = 0; i < 50; i++) {
		await new Promise((r) => setTimeout(r, 100));
		token = await getDiscoveryToken();
		if (token) {
			process.stderr.write("\x1b[1;32m[discovery]\x1b[0m service started\n");
			return token;
		}
	}
	throw new Error("Discovery service failed to start within 5 seconds");
}

async function registerSession(sessionId: string, port: number, cwd: string): Promise<void> {
	await fetchDiscovery("/api/sessions", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ sessionId, port, cwd }),
	});
}

async function deregisterSession(sessionId: string): Promise<void> {
	await fetchDiscovery(`/api/sessions/${sessionId}`, { method: "DELETE" });
}

// ---------- Session ID ----------

/** Generate a short session ID for the serve path */
function generateSessionId(): string {
	return cryptoRandomBytes(4).toString("hex"); // 8 hex chars
}

// ---------- Public API ----------

export interface RemoteOptions {
	/**
	 * Path to the pi binary (or any executable to run in the PTY).
	 * When omitted, pi-remote tries to locate `pi` on PATH.
	 */
	piPath?: string;
	/** Extra arguments forwarded to pi (e.g. ["-c", "--model", "sonnet"]) */
	args?: string[];
	/** Working directory for pi. Default: process.cwd() */
	cwd?: string;
	/** Environment variables forwarded to pi. Default: process.env */
	env?: Record<string, string>;
}

/**
 * Resolve the `pi` binary path.
 * Tries options.piPath first, then searches PATH.
 */
function resolvePiPath(piPath?: string): string {
	if (piPath) return piPath;

	for (const cmd of ["which pi", "command -v pi"]) {
		try {
			const result = execSync(cmd, {
				encoding: "utf-8" as const,
				env: process.env,
			}).trim();
			if (result && !result.includes("\n")) return result;
		} catch {
			// try next
		}
	}
	throw new Error('Could not find "pi" binary. Pass piPath explicitly or ensure pi is on PATH.');
}

/**
 * Start a remote pi session:
 *  1. Ensure the discovery service is running and get the shared token
 *  2. Start the HTTP server (static web UI + /api/local-url)
 *  3. Attach the WebSocket terminal bridge
 *  4. Register this session with the discovery service
 *  5. Set up Tailscale serve for this session's subpath
 *  6. Pass remote URL to pi via PI_REMOTE_URL env var
 *  7. Spawn pi inside a PTY with local terminal attached
 *
 * The extension (loaded by pi) reads PI_REMOTE_URL and shows
 * a persistent widget with the remote URL in the TUI.
 *
 * Returns a cleanup function that kills the PTY and stops the server.
 */
export async function startRemote(options: RemoteOptions = {}): Promise<() => void> {
	const piPath = resolvePiPath(options.piPath);
	const sessionId = generateSessionId();
	const cwd = options.cwd ?? process.cwd();

	// 1. Ensure discovery service is running and get shared token
	const token = await ensureDiscoveryService();
	setAccessToken(token);

	// 2. Start HTTP server (so the port is known before printing the URL)
	const httpServer = await startServer();
	setupTerminalWebSocket(httpServer);

	const port = getPort();
	const url = getLocalUrl();

	// 3. Register this session with the discovery service
	await registerSession(sessionId, port, cwd);

	// 4. Try to set up Tailscale serve for this session's subpath
	const tsBin = findTailscaleBin();
	let tailscaleUrl: string | null = null;
	const tsServePath = `/pi/${sessionId}/`;
	process.stderr.write(`\x1b[1;35m[tailscale]\x1b[0m binary: ${tsBin ?? "not found"}\n`);
	if (tsBin) {
		const hostname = getTailscaleHostname(tsBin);
		process.stderr.write(`\x1b[1;35m[tailscale]\x1b[0m hostname: ${hostname ?? "not found"}\n`);
		if (hostname) {
			const serveCmd = `${JSON.stringify(tsBin)} serve --bg --https 443 --set-path ${JSON.stringify(tsServePath)} http://localhost:${port}`;
			process.stderr.write(`\x1b[1;35m[tailscale]\x1b[0m running: ${serveCmd}\n`);
			const served = tailscaleServe(tsBin, port, tsServePath);
			process.stderr.write(`\x1b[1;35m[tailscale]\x1b[0m serve result: ${served ? "ok" : "failed"}\n`);
			if (served) {
				tailscaleUrl = `https://${hostname}${tsServePath}?token=${token}`;
				setServerTailscaleUrl(tailscaleUrl);
				process.stderr.write(`\x1b[1;35m[tailscale]\x1b[0m url: ${tailscaleUrl}\n`);
			}
		}
	}

	// 5. Build discovery URL for the TUI widget
	let discoveryUrl: string | null = null;
	if (tsBin && tailscaleUrl) {
		// Extract base Tailscale URL (hostname) from the session URL
		const hostname = getTailscaleHostname(tsBin);
		if (hostname) {
			discoveryUrl = `https://${hostname}/pi/?token=${token}`;
		}
	}

	// 6. Pass the remote URL to pi so the extension can display it in the TUI
	const piEnv: Record<string, string> = {
		...(options.env ?? (process.env as Record<string, string>)),
		PI_REMOTE_URL: url,
		...(tailscaleUrl ? { PI_REMOTE_TAILSCALE_URL: tailscaleUrl } : {}),
		...(discoveryUrl ? { PI_REMOTE_DISCOVERY_URL: discoveryUrl } : {}),
	};

	// 7. Spawn pi in the PTY with local terminal attached
	const cols = process.stdout.columns || 120;
	const rows = process.stdout.rows || 30;

	await spawnInPty({
		command: piPath,
		args: options.args ?? [],
		cwd,
		env: piEnv,
		cols,
		rows,
		attachLocal: true,
	});

	// Exit when pi exits — delay briefly so WebSocket can send the exit message to browsers
	onPtyExit((exitCode) => {
		setTimeout(async () => {
			if (tsBin && tailscaleUrl) tailscaleServeOff(tsBin, tsServePath);
			await deregisterSession(sessionId);
			httpServer.close();
			process.exit(exitCode);
		}, 500);
	});

	// Register cleanup
	const cleanup = (): void => {
		if (tsBin && tailscaleUrl) tailscaleServeOff(tsBin, tsServePath);
		deregisterSession(sessionId).catch(() => {});
		killPty();
		httpServer.close();
	};

	process.on("SIGINT", () => {
		cleanup();
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		cleanup();
		process.exit(0);
	});

	return cleanup;
}
