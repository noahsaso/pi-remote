/**
 * HTTP server: serves the web UI, handles token auth for remote clients,
 * and exposes /api/local-url for generating the shareable LAN link.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const START_PORT = 7009;
const MAX_PORT = 7099;
const HOST = "0.0.0.0";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".woff": "font/woff",
};

/** One-time random token for LAN access auth. Local clients are exempt. */
export const ACCESS_TOKEN = randomBytes(16).toString("hex");

let server: Server | null = null;
let actualPort = START_PORT;

export function getPort(): number {
	return actualPort;
}

export function getLocalUrl(): string {
	const nets = networkInterfaces();
	let localIp = "127.0.0.1";
	outer: for (const ifaces of Object.values(nets)) {
		for (const iface of ifaces ?? []) {
			if (iface.family === "IPv4" && !iface.internal) {
				localIp = iface.address;
				break outer;
			}
		}
	}
	return `http://${localIp}:${actualPort}?token=${ACCESS_TOKEN}`;
}

/** Resolve the dist/web directory shipped with the package */
function getWebDir(): string {
	// In built dist/: web assets are in ../web-dist (copied during build)
	// In dev (src/): same relative path works because we build web first
	return join(__dirname, "..", "web-dist");
}

async function handleRequest(
	req: import("node:http").IncomingMessage,
	res: import("node:http").ServerResponse,
): Promise<void> {
	const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
	const url = parsedUrl.pathname;
	const method = req.method ?? "GET";

	// WebSocket upgrade is handled elsewhere
	if (url === "/ws/terminal") return;

	// CORS
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");
	if (method === "OPTIONS") {
		res.writeHead(200);
		res.end();
		return;
	}

	// Token auth: local connections and static assets are exempt
	const remoteIp = req.socket.remoteAddress ?? "";
	const isLocal = remoteIp === "127.0.0.1" || remoteIp === "::1" || remoteIp === "::ffff:127.0.0.1";
	const isStaticAsset = url.startsWith("/assets/") || url === "/favicon.ico";

	if (!isLocal && !isStaticAsset) {
		const urlToken = parsedUrl.searchParams.get("token");
		if (urlToken !== ACCESS_TOKEN) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Forbidden: invalid token" }));
			return;
		}
	}

	// API: return the LAN URL with token (for QR code generation in the UI)
	if (url === "/api/local-url" && method === "GET") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ url: getLocalUrl() }));
		return;
	}

	// Static file serving from web-dist/
	if (method === "GET") {
		const webDir = getWebDir();
		const filePath = url === "/" ? "/index.html" : url.split("?")[0];
		const fullPath = join(webDir, filePath);

		if (existsSync(fullPath) && statSync(fullPath).isFile()) {
			const content = readFileSync(fullPath);
			const ct = MIME[extname(filePath)] ?? "application/octet-stream";
			res.writeHead(200, { "Content-Type": ct });
			res.end(content);
			return;
		}

		// SPA fallback
		const indexPath = join(webDir, "index.html");
		if (existsSync(indexPath)) {
			const html = readFileSync(indexPath, "utf-8");
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(html);
			return;
		}
	}

	res.writeHead(404);
	res.end("Not Found");
}

export function startServer(): Promise<Server> {
	return new Promise((resolve, reject) => {
		function tryListen(port: number): void {
			if (port > MAX_PORT) {
				reject(new Error(`No available port between ${START_PORT} and ${MAX_PORT}`));
				return;
			}

			// Probe whether the port is free on 127.0.0.1 first
			const probe = createConnection({ host: "127.0.0.1", port });
			probe.on("connect", () => {
				probe.destroy();
				tryListen(port + 1);
			});
			probe.on("error", () => {
				probe.destroy();

				const httpServer = createServer(handleRequest);

				httpServer.listen(port, HOST, () => {
					server = httpServer;
					actualPort = port;
					resolve(httpServer);
				});

				httpServer.on("error", (err: NodeJS.ErrnoException) => {
					if (err.code === "EADDRINUSE") {
						tryListen(port + 1);
					} else {
						reject(err);
					}
				});
			});
		}

		tryListen(START_PORT);
	});
}

export function stopServer(): void {
	if (server) {
		server.close();
		server = null;
	}
}
