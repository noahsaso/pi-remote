/**
 * Discovery service: lists all active pi-remote sessions.
 *
 * Runs as a detached process on port 7008. The first pi-remote session
 * spawns it; subsequent sessions register against it. When the last
 * session deregisters, the service cleans up its Tailscale route and exits.
 *
 * Localhost API (no auth):
 *   GET  /api/token         → { token }
 *   GET  /api/sessions      → { sessions: [...] }
 *   POST /api/sessions      → register { sessionId, port, cwd }
 *   DELETE /api/sessions/:id → deregister (auto-shutdown when empty)
 *
 * Web UI (token-authed):
 *   GET / → session list (cards with cwd + relative time)
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findTailscaleBin, getTailscaleHostname, tailscaleServe, tailscaleServeOff } from "./tailscale.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_SESSIONS = 10;

export const DISCOVERY_PORT = 7008;
const HOST = "0.0.0.0";

interface Session {
	sessionId: string;
	port: number;
	cwd: string;
	startedAt: string; // ISO string
}

const sessions = new Map<string, Session>();
const TOKEN = randomBytes(16).toString("hex");
let persistentMode = false;

let server: Server | null = null;
let tsBin: string | null = null;
let tsHostname: string | null = null;
let tailscaleUrl: string | null = null;
const TS_SERVE_PATH = "/pi/";

// ---------- Helpers ----------

function relativeTime(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins} min ago`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
	return `${Math.floor(hrs / 24)}d ago`;
}

function isLocalhost(req: IncomingMessage): boolean {
	const addr = req.socket.remoteAddress;
	return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

// ---------- HTML rendering ----------

function sessionCard(s: Session, baseUrl: string, token: string): string {
	const url = `${baseUrl}/pi/${s.sessionId}/?token=${token}`;
	const escapedCwd = s.cwd.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return `
<a href="${url}" class="card">
	<div class="cwd">${escapedCwd}</div>
	<div class="meta">${s.sessionId} · ${relativeTime(s.startedAt)}</div>
</a>`;
}

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
  btn.textContent='Starting\u2026';
  fetch('api/spawn?token=${TOKEN}',{method:'POST'})
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

function styledErrorPage(title: string, message: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>pi remote</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:#0a0a0a;color:#d4d4d4;font-family:system-ui,sans-serif}
body{display:flex;align-items:center;justify-content:center}
.card{background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:24px 28px;max-width:300px;width:90%;text-align:center}
h2{margin-bottom:8px;font-size:16px;color:#e0e0e0}
p{font-size:12px;color:#888}
</style>
</head>
<body>
<div class="card">
<h2>${title}</h2>
<p>${message}</p>
</div>
</body>
</html>`;
}

// ---------- Request handler ----------

function shutdown(): void {
	if (tsBin && tailscaleUrl) tailscaleServeOff(tsBin, TS_SERVE_PATH);
	server?.close();
	process.exit(0);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
	const url = parsedUrl.pathname;
	const method = req.method ?? "GET";

	// CORS
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");
	if (method === "OPTIONS") {
		res.writeHead(200);
		res.end();
		return;
	}

	// Localhost-only API (no token needed — same machine only)
	if (isLocalhost(req)) {
		if (url === "/api/token" && method === "GET") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ token: TOKEN }));
			return;
		}

		if (url === "/api/sessions" && method === "GET") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ sessions: Array.from(sessions.values()) }));
			return;
		}

		if (url === "/api/sessions" && method === "POST") {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk as Buffer);
			const body = JSON.parse(Buffer.concat(chunks).toString());
			const { sessionId, port, cwd } = body;
			sessions.set(sessionId, { sessionId, port, cwd, startedAt: new Date().toISOString() });
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
			return;
		}

		if (url.startsWith("/api/sessions/") && method === "DELETE") {
			const sessionId = url.slice("/api/sessions/".length);
			sessions.delete(sessionId);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
			// Shut down if no sessions remain (unless running in persistent mode)
			if (sessions.size === 0 && !persistentMode) setTimeout(shutdown, 500);
			return;
		}
	}

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

	// Web UI: token-authed
	if (url === "/" && method === "GET") {
		const urlToken = parsedUrl.searchParams.get("token");
		if (urlToken !== TOKEN) {
			res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
			res.end(styledErrorPage("Access denied", "Invalid or missing access token."));
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(renderPage());
		return;
	}

	res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
	res.end(styledErrorPage("Not found", "This page does not exist."));
}

// ---------- Server startup ----------

export function startDiscoveryService(persistent = false): Promise<void> {
	persistentMode = persistent;
	return new Promise((resolve, reject) => {
		const httpServer = createServer(handleRequest);

		httpServer.listen(DISCOVERY_PORT, HOST, () => {
			server = httpServer;

			// Set up Tailscale route for /pi/
			tsBin = findTailscaleBin();
			if (tsBin) {
				tsHostname = getTailscaleHostname(tsBin);
				if (tsHostname) {
					const served = tailscaleServe(tsBin, DISCOVERY_PORT, TS_SERVE_PATH);
					if (served) {
						tailscaleUrl = `https://${tsHostname}${TS_SERVE_PATH}`;
					}
				}
			}

			resolve();
		});

		httpServer.on("error", (err: NodeJS.ErrnoException) => {
			reject(err);
		});
	});
}
