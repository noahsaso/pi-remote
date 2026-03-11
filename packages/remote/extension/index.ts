/**
 * Remote Access Extension
 *
 * Registers a `/remote` command that restarts pi in remote mode,
 * wrapping it in a PTY with WebSocket access for mobile/browser clients.
 *
 * When running inside pi-remote (detected via PI_REMOTE_URL env var),
 * shows a persistent widget with the remote URL above the editor.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolvePiRemoteBin(): string {
	const localBin = join(__dirname, "..", "dist", "cli.js");
	if (existsSync(localBin)) return localBin;

	try {
		const result = execSync("which pi-remote", { encoding: "utf-8" }).trim();
		if (result) return result;
	} catch {
		// not found
	}

	throw new Error("Could not find pi-remote binary. Install @q.roy/pi-remote or ensure pi-remote is on PATH.");
}

function resolvePiBin(): string {
	for (const cmd of ["which pi", "command -v pi"]) {
		try {
			const result = execSync(cmd, { encoding: "utf-8" }).trim();
			if (result && !result.includes("\n")) return result;
		} catch {}
	}
	throw new Error("Could not find pi binary on PATH.");
}

export default function (pi: ExtensionAPI) {
	let pendingAction: "remote" | "end-remote" | null = null;
	let sessionFileForAction: string | undefined;

	const isRemoteSession = !!process.env.PI_REMOTE_URL;

	if (!isRemoteSession) {
		// ---------- /remote command (only when NOT in remote mode) ----------
		pi.registerCommand("remote", {
			description: "Start remote access server (share session via browser)",
			handler: async (_args, ctx) => {
				if (!ctx.hasUI) {
					ctx.ui.notify("Remote mode is only available in interactive mode.", "error");
					return;
				}

				await ctx.waitForIdle();

				sessionFileForAction = ctx.sessionManager.getSessionFile();
				pendingAction = "remote";

				ctx.ui.notify("Restarting pi in remote mode. Your session will be preserved.", "info");
				ctx.shutdown();
			},
		});
	} else {
		// ---------- /remote:end command (only when in remote mode) ----------
		pi.registerCommand("remote:end", {
			description: "Stop remote access and restart pi normally",
			handler: async (_args, ctx) => {
				await ctx.waitForIdle();

				sessionFileForAction = ctx.sessionManager.getSessionFile();
				pendingAction = "end-remote";

				ctx.ui.notify("Stopping remote access. Your session will be preserved.", "info");
				ctx.shutdown();
			},
		});
	}

	pi.on("session_shutdown", async () => {
		if (!pendingAction) return;
		const action = pendingAction;
		pendingAction = null;

		const extensionPath = join(__dirname, "index.ts");

		if (action === "remote") {
			const bin = resolvePiRemoteBin();
			const piArgs = ["-e", extensionPath, ...(sessionFileForAction ? ["--session", sessionFileForAction] : [])];
			const isJs = bin.endsWith(".js");
			const command = isJs ? process.execPath : bin;
			const args = isJs ? [bin, "--", ...piArgs] : ["--", ...piArgs];

			const origExit = process.exit;
			process.exit = ((_code?: number) => {
				process.exit = origExit;
				try {
					const result = spawnSync(command, args, {
						stdio: "inherit",
						cwd: process.cwd(),
						env: process.env as Record<string, string>,
					});
					origExit(result.status ?? 1);
				} catch {
					origExit(1);
				}
			}) as typeof process.exit;
		} else if (action === "end-remote") {
			// Restart plain pi without the remote wrapper — strip remote env vars
			const piBin = resolvePiBin();
			const piArgs = ["-e", extensionPath, ...(sessionFileForAction ? ["--session", sessionFileForAction] : [])];
			const cleanEnv = { ...(process.env as Record<string, string>) };
			delete cleanEnv.PI_REMOTE_URL;
			delete cleanEnv.PI_REMOTE_TAILSCALE_URL;
			delete cleanEnv.PI_REMOTE_DISCOVERY_URL;

			const origExit = process.exit;
			process.exit = ((_code?: number) => {
				process.exit = origExit;
				try {
					const result = spawnSync(piBin, piArgs, {
						stdio: "inherit",
						cwd: process.cwd(),
						env: cleanEnv,
					});
					origExit(result.status ?? 1);
				} catch {
					origExit(1);
				}
			}) as typeof process.exit;
		}
	});

	// ---------- Remote URL widget ----------

	pi.on("session_start", async (_event, ctx) => {
		const remoteUrl = process.env.PI_REMOTE_URL;
		if (!remoteUrl) return;

		const tailscaleUrl = process.env.PI_REMOTE_TAILSCALE_URL;
		const discoveryUrl = process.env.PI_REMOTE_DISCOVERY_URL;
		const contentLines: string[] = [];
		if (tailscaleUrl) {
			contentLines.push("  \x1b[1;35mTailscale:\x1b[0m " + tailscaleUrl);
		}
		contentLines.push("  \x1b[1;36mLAN:\x1b[0m " + remoteUrl);

		// Extract token from the URL
		const tokenMatch = remoteUrl.match(/[?&]token=([^&]+)/);
		if (tokenMatch) {
			contentLines.push("  \x1b[1;33mToken:\x1b[0m " + tokenMatch[1]);
		}
		if (discoveryUrl) {
			contentLines.push("  \x1b[1;32mAll sessions:\x1b[0m " + discoveryUrl);
		}

		const title = " Remote access ";
		const topBorder = `\x1b[90m╭${title}${"─".repeat(40)}╮\x1b[0m`;
		const botBorder = `\x1b[90m╰${"─".repeat(40 + title.length)}╯\x1b[0m`;

		const lines = [topBorder, ...contentLines, botBorder];
		ctx.ui.setWidget("remote-url", lines);
	});
}
