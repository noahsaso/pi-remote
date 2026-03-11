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
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Box, Text } from "@mariozechner/pi-tui";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const qrcodeTerminal = require("qrcode-terminal") as {
	generate: (input: string, options: { small?: boolean }, callback: (output: string) => void) => void;
};
const REMOTE_QR_MESSAGE_TYPE = "remote-qr";

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

function renderQrLines(url: string): string[] {
	let rendered = "";
	qrcodeTerminal.generate(url, { small: true }, (output) => {
		rendered = output;
	});
	return rendered
		.trimEnd()
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => `  ${line}`);
}

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-9;]*m/g, "");
}

function buildBorderedWidget(title: string, contentLines: string[]): string[] {
	const innerWidth = Math.max(
		title.length + 2,
		...contentLines.map((line) => stripAnsi(line).length),
	);
	const topBorder = `\x1b[90m╭ ${title} ${"─".repeat(Math.max(0, innerWidth - title.length - 2))}╮\x1b[0m`;
	const bottomBorder = `\x1b[90m╰${"─".repeat(innerWidth + 2)}╯\x1b[0m`;
	const body = contentLines.map((line) => {
		const visible = stripAnsi(line).length;
		return `\x1b[90m│\x1b[0m${line}${" ".repeat(Math.max(0, innerWidth - visible))}\x1b[90m│\x1b[0m`;
	});
	return [topBorder, ...body, bottomBorder];
}

function buildRemoteQrMessage(info: NonNullable<ReturnType<typeof getRemoteInfo>>, qrUrl: string): string {
	const lines: string[] = [];
	if (info.tailscaleUrl) {
		lines.push(`  Tailscale:      ${info.tailscaleUrl}`);
	}
	lines.push(`  LAN:            ${info.remoteUrl}`);
	if (info.token) {
		lines.push(`  Token:          ${info.token}`);
	}
	if (info.discoveryUrl) {
		lines.push(`  All sessions:   ${info.discoveryUrl}`);
	}
	lines.push("", "  Scan to open on mobile:", "", ...renderQrLines(qrUrl));
	return lines.join("\n");
}

function getRemoteInfo() {
	const remoteUrl = process.env.PI_REMOTE_URL;
	if (!remoteUrl) return null;
	const tailscaleUrl = process.env.PI_REMOTE_TAILSCALE_URL;
	const discoveryUrl = process.env.PI_REMOTE_DISCOVERY_URL;
	const primaryUrl = tailscaleUrl ?? remoteUrl;
	const tokenMatch = primaryUrl.match(/[?&]token=([^&]+)/);
	return {
		remoteUrl,
		tailscaleUrl,
		discoveryUrl,
		primaryUrl,
		token: tokenMatch?.[1],
	};
}

function buildRemoteWidgetLines(info: NonNullable<ReturnType<typeof getRemoteInfo>>): string[] {
	const contentLines: string[] = [];
	if (info.tailscaleUrl) {
		contentLines.push("  \x1b[1;35mTailscale:\x1b[0m " + info.tailscaleUrl);
	}
	contentLines.push("  \x1b[1;36mLAN:\x1b[0m " + info.remoteUrl);
	if (info.token) {
		contentLines.push("  \x1b[1;33mToken:\x1b[0m " + info.token);
	}
	if (info.discoveryUrl) {
		contentLines.push("  \x1b[1;32mAll sessions:\x1b[0m " + info.discoveryUrl);
	}
	const title = " Remote access ";
	const topBorder = `\x1b[90m╭${title}${"─".repeat(40)}╮\x1b[0m`;
	const botBorder = `\x1b[90m╰${"─".repeat(40 + title.length)}╯\x1b[0m`;
	return [topBorder, ...contentLines, botBorder];
}

export default function (pi: ExtensionAPI) {
	let pendingAction: "remote" | "end-remote" | null = null;
	let sessionFileForAction: string | undefined;
	let pendingQrOverrideUrl: string | undefined;
	let widgetVisible = false;

	pi.registerMessageRenderer(REMOTE_QR_MESSAGE_TYPE, (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${theme.fg("accent", theme.bold("[Remote access]"))}\n${content}`, 0, 0));
		return box;
	});

	const isRemoteSession = !!process.env.PI_REMOTE_URL;

	const updateRemoteWidget = (ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }) => {
		const info = getRemoteInfo();
		if (!info || !widgetVisible) {
			ctx.ui.setWidget("remote-url", undefined);
			return;
		}
		ctx.ui.setWidget("remote-url", buildRemoteWidgetLines(info));
	};

	if (!isRemoteSession) {
		// ---------- /remote command (only when NOT in remote mode) ----------
		pi.registerCommand("remote", {
			description: "Start remote access server (share session via browser). Optional: /remote <qr-url> to override the QR code target.",
			handler: async (args, ctx) => {
				if (!ctx.hasUI) {
					ctx.ui.notify("Remote mode is only available in interactive mode.", "error");
					return;
				}

				await ctx.waitForIdle();

				sessionFileForAction = ctx.sessionManager.getSessionFile();
				pendingQrOverrideUrl = args.trim() || undefined;
				pendingAction = "remote";

				ctx.ui.notify(
					pendingQrOverrideUrl
						? `Restarting pi in remote mode with QR override: ${pendingQrOverrideUrl}`
						: "Restarting pi in remote mode. Your session will be preserved.",
					"info",
				);
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

		pi.registerCommand("remote:widget", {
			description: "Show, hide, or toggle the remote info widget",
			handler: async (args, ctx) => {
				const mode = args.trim().toLowerCase();
				if (mode === "on" || mode === "show") {
					widgetVisible = true;
				} else if (mode === "off" || mode === "hide") {
					widgetVisible = false;
				} else if (mode === "" || mode === "toggle") {
					widgetVisible = !widgetVisible;
				} else if (mode === "status") {
					ctx.ui.notify(`Remote widget is ${widgetVisible ? "shown" : "hidden"}.`, "info");
					return;
				} else {
					ctx.ui.notify("Usage: /remote:widget [on|off|toggle|status]", "warning");
					return;
				}

				updateRemoteWidget(ctx);
				ctx.ui.notify(`Remote widget ${widgetVisible ? "shown" : "hidden"}.`, "info");
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
			const childEnv = { ...(process.env as Record<string, string>) };
			if (pendingQrOverrideUrl) {
				childEnv.PI_REMOTE_QR_OVERRIDE_URL = pendingQrOverrideUrl;
			} else {
				delete childEnv.PI_REMOTE_QR_OVERRIDE_URL;
			}

			const origExit = process.exit;
			process.exit = ((_code?: number) => {
				process.exit = origExit;
				try {
					const result = spawnSync(command, args, {
						stdio: "inherit",
						cwd: process.cwd(),
						env: childEnv,
					});
					origExit(result.status ?? 1);
				} catch {
					origExit(1);
				}
			}) as typeof process.exit;
		} else if (action === "end-remote") {
			// Write restart config for the pi-remote wrapper to pick up after cleanup
			const restartFile = process.env.PI_REMOTE_RESTART_FILE;
			if (restartFile) {
				const piBin = resolvePiBin();
				const piArgs = ["-e", extensionPath, ...(sessionFileForAction ? ["--session", sessionFileForAction] : [])];
				const cleanEnv = { ...(process.env as Record<string, string>) };
				delete cleanEnv.PI_REMOTE_URL;
				delete cleanEnv.PI_REMOTE_TAILSCALE_URL;
				delete cleanEnv.PI_REMOTE_DISCOVERY_URL;
				delete cleanEnv.PI_REMOTE_RESTART_FILE;
				delete cleanEnv.PI_REMOTE_QR_OVERRIDE_URL;

				writeFileSync(
					restartFile,
					JSON.stringify({ command: piBin, args: piArgs, cwd: process.cwd(), env: cleanEnv }),
				);
			}
			// Just exit — the pi-remote wrapper's onPtyExit will handle cleanup + respawn
		}
	});

	// ---------- Remote URL widget ----------

	pi.on("session_start", async (_event, ctx) => {
		const info = getRemoteInfo();
		if (!info) return;
		const qrUrl = process.env.PI_REMOTE_QR_OVERRIDE_URL || info.primaryUrl;

		updateRemoteWidget(ctx);

		pi.sendMessage({
			customType: REMOTE_QR_MESSAGE_TYPE,
			content: buildRemoteQrMessage(info, qrUrl),
			display: true,
			details: {
				primaryUrl: info.primaryUrl,
				remoteUrl: info.remoteUrl,
				tailscaleUrl: info.tailscaleUrl,
				discoveryUrl: info.discoveryUrl,
				timestamp: Date.now(),
			},
		});
	});
}
