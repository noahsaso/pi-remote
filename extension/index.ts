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

export default function (pi: ExtensionAPI) {
	let pendingRemote = false;
	let sessionFileForRemote: string | undefined;

	// ---------- /remote command ----------

	pi.registerCommand("remote", {
		description: "Start remote access server (share session via browser)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Remote mode is only available in interactive mode.", "error");
				return;
			}

			await ctx.waitForIdle();

			sessionFileForRemote = ctx.sessionManager.getSessionFile();
			pendingRemote = true;

			ctx.ui.notify("Restarting pi in remote mode. Your session will be preserved.", "info");
			ctx.shutdown();
		},
	});

	pi.on("session_shutdown", async () => {
		if (!pendingRemote) return;
		pendingRemote = false;

		const bin = resolvePiRemoteBin();
		const extensionPath = join(__dirname, "index.ts");
		const piArgs = ["-e", extensionPath, ...(sessionFileForRemote ? ["--continue"] : [])];
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
	});

	// ---------- Remote URL widget ----------

	pi.on("session_start", async (_event, ctx) => {
		const remoteUrl = process.env.PI_REMOTE_URL;
		if (!remoteUrl) return;

		ctx.ui.setWidget("remote-url", ["\x1b[1;36mRemote:\x1b[0m " + remoteUrl]);
	});
}
