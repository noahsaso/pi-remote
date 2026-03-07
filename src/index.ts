/**
 * pi-remote: start pi inside a PTY and expose it over WebSocket for remote
 * browser/mobile access.
 *
 * Usage:
 *   import { startRemote } from "@q.roy/pi-remote";
 *   await startRemote({ piPath: "/path/to/pi", args: ["-c"] });
 */

import { execSync } from "node:child_process";
import { killPty, onPtyExit, spawnInPty } from "./pty.js";
import { ACCESS_TOKEN, getLocalUrl, getPort, startServer } from "./server.js";
import { setupTerminalWebSocket } from "./ws.js";

export { ACCESS_TOKEN, getLocalUrl, getPort };

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

	const url = getLocalUrl();

	// Pass the remote URL to pi so the extension can display it in the TUI
	const piEnv = { ...(options.env ?? (process.env as Record<string, string>)), PI_REMOTE_URL: url };

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

	// Exit when pi exits
	onPtyExit((exitCode) => {
		httpServer.close();
		process.exit(exitCode);
	});

	// Register cleanup
	const cleanup = (): void => {
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
