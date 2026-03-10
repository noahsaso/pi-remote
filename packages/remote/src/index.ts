/**
 * pi-remote: start pi inside a PTY and expose it over WebSocket for remote
 * browser/mobile access.
 *
 * Usage:
 *   import { startRemote } from "@q.roy/pi-remote";
 *   await startRemote({ piPath: "/path/to/pi", args: ["-c"] });
 */

import { execSync } from "node:child_process";
import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { killPty, onPtyExit, spawnInPty } from "./pty.js";
import { ACCESS_TOKEN, getLocalUrl, getPort, setTailscaleUrl as setServerTailscaleUrl, startServer } from "./server.js";
import { setupTerminalWebSocket } from "./ws.js";

export { ACCESS_TOKEN, getLocalUrl, getPort };

// ---------- Tailscale integration ----------

const TAILSCALE_PATHS = [
	"/usr/local/bin/tailscale",
	"/usr/bin/tailscale",
	"/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

function findTailscaleBin(): string | null {
	// Check PATH first
	for (const cmd of ["which tailscale", "command -v tailscale"]) {
		try {
			const result = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
			if (result) {
				process.stderr.write(`\x1b[1;35m[tailscale]\x1b[0m found via "${cmd}": ${result}\n`);
				return result;
			}
		} catch {}
	}
	// Check known locations
	for (const p of TAILSCALE_PATHS) {
		try {
			if (statSync(p)) {
				process.stderr.write(`\x1b[1;35m[tailscale]\x1b[0m found at known path: ${p}\n`);
				return p;
			}
		} catch {}
	}
	process.stderr.write(`\x1b[1;35m[tailscale]\x1b[0m not found in PATH or known locations\n`);
	return null;
}

function getTailscaleHostname(bin: string): string | null {
	try {
		const json = execSync(`${JSON.stringify(bin)} status --json`, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		const dnsName: string = JSON.parse(json)?.Self?.DNSName;
		// Remove trailing dot
		return dnsName?.replace(/\.$/, "") ?? null;
	} catch {
		return null;
	}
}

/** Generate a short session ID for the serve path */
function generateSessionId(): string {
	return cryptoRandomBytes(4).toString("hex"); // 8 hex chars
}

function tailscaleServe(bin: string, port: number, path: string): boolean {
	try {
		execSync(
			`${JSON.stringify(bin)} serve --bg --https 443 --set-path ${JSON.stringify(path)} http://localhost:${port}`,
			{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
		);
		return true;
	} catch {
		return false;
	}
}

function tailscaleServeOff(bin: string, path: string): void {
	try {
		execSync(`${JSON.stringify(bin)} serve --https 443 --set-path ${JSON.stringify(path)} off`, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch {}
}

export function getTailscaleUrl(): string | null {
	const bin = findTailscaleBin();
	if (!bin) return null;
	const hostname = getTailscaleHostname(bin);
	if (!hostname) return null;
	return `https://${hostname}`;
}

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
 *  1. Start the HTTP server (static web UI + /api/local-url)
 *  2. Attach the WebSocket terminal bridge
 *  3. Pass remote URL to pi via PI_REMOTE_URL env var
 *  4. Spawn pi inside a PTY with local terminal attached
 *
 * The extension (loaded by pi) reads PI_REMOTE_URL and shows
 * a persistent widget with the remote URL in the TUI.
 *
 * Returns a cleanup function that kills the PTY and stops the server.
 */
export async function startRemote(options: RemoteOptions = {}): Promise<() => void> {
	const piPath = resolvePiPath(options.piPath);

	// Start HTTP server first (so the port is known before printing the URL)
	const httpServer = await startServer();
	setupTerminalWebSocket(httpServer);

	const port = getPort();
	const url = getLocalUrl();

	// Try to set up Tailscale serve for the remote port on a unique subpath
	const tsBin = findTailscaleBin();
	let tailscaleUrl: string | null = null;
	const sessionId = generateSessionId();
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
				tailscaleUrl = `https://${hostname}${tsServePath}?token=${ACCESS_TOKEN}`;
				setServerTailscaleUrl(tailscaleUrl);
				process.stderr.write(`\x1b[1;35m[tailscale]\x1b[0m url: ${tailscaleUrl}\n`);
			}
		}
	}

	// Pass the remote URL to pi so the extension can display it in the TUI
	const piEnv: Record<string, string> = {
		...(options.env ?? (process.env as Record<string, string>)),
		PI_REMOTE_URL: url,
		...(tailscaleUrl ? { PI_REMOTE_TAILSCALE_URL: tailscaleUrl } : {}),
	};

	// Spawn pi in the PTY with local terminal attached
	const cols = process.stdout.columns || 120;
	const rows = process.stdout.rows || 30;

	await spawnInPty({
		command: piPath,
		args: options.args ?? [],
		cwd: options.cwd ?? process.cwd(),
		env: piEnv,
		cols,
		rows,
		attachLocal: true,
	});

	// Exit when pi exits — delay briefly so WebSocket can send the exit message to browsers
	onPtyExit((exitCode) => {
		setTimeout(() => {
			if (tsBin && tailscaleUrl) tailscaleServeOff(tsBin, tsServePath);
			httpServer.close();
			process.exit(exitCode);
		}, 500);
	});

	// Register cleanup
	const cleanup = (): void => {
		if (tsBin && tailscaleUrl) tailscaleServeOff(tsBin, tsServePath);
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
