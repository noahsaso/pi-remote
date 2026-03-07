/**
 * WebSocket bridge: connects browser clients to the PTY.
 *
 * Multiple clients share one PTY. Mobile clients take priority for terminal
 * sizing to avoid wide-screen output breaking mobile displays.
 */

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import { getOutputBuffer, getPtyState, onPtyData, onPtyExit, resizePty, writeToPty } from "./pty.js";

interface ClientSize {
	cols: number;
	rows: number;
}

// WS message types sent from browser → server
type BrowserMessage =
	| { type: "input"; data: string }
	| { type: "resize"; cols: number; rows: number; mobile?: boolean };

// WS message types sent from server → browser
type ServerMessage =
	| { type: "data"; data: string }
	| { type: "exit"; exitCode: number | null }
	| { type: "state"; running: boolean; exitCode: number | null };

function send(ws: WebSocket, msg: ServerMessage): void {
	if (ws.readyState === ws.OPEN) {
		ws.send(JSON.stringify(msg));
	}
}

export function setupTerminalWebSocket(httpServer: Server): void {
	const wss = new WebSocketServer({ noServer: true });

	// Per-client state
	let activeWs: WebSocket | null = null;
	const clientSizes = new Map<WebSocket, ClientSize>();
	const mobileClients = new Set<WebSocket>();

	const getMobileSize = (): ClientSize | null => {
		for (const mws of mobileClients) {
			if (mws.readyState === mws.OPEN) {
				const size = clientSizes.get(mws);
				if (size) return size;
			}
		}
		return null;
	};

	httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		const pathname = new URL(req.url ?? "/", `http://${req.headers.host}`).pathname;
		if (pathname === "/ws/terminal") {
			wss.handleUpgrade(req, socket, head, (ws) => {
				wss.emit("connection", ws, req);
			});
		} else {
			socket.destroy();
		}
	});

	wss.on("connection", (ws: WebSocket) => {
		// Send current PTY state to the new client
		const state = getPtyState();
		send(ws, { type: "state", ...state });

		// Replay history buffer so late joiners see past output
		const buffer = getOutputBuffer();
		if (buffer) {
			send(ws, { type: "data", data: buffer });
		}

		// Forward PTY output to this client
		const removeDataListener = onPtyData((data) => {
			send(ws, { type: "data", data });
		});

		const removeExitListener = onPtyExit((exitCode) => {
			send(ws, { type: "exit", exitCode });
		});

		ws.on("message", (raw) => {
			try {
				const msg = JSON.parse(raw.toString()) as BrowserMessage;

				if (msg.type === "input") {
					// The sender becomes the active client
					if (activeWs !== ws) {
						activeWs = ws;
						// Apply sizing: mobile takes priority
						const mSize = getMobileSize();
						if (mSize) {
							resizePty(mSize.cols, mSize.rows);
						} else {
							const size = clientSizes.get(ws);
							if (size) resizePty(size.cols, size.rows);
						}
					}
					writeToPty(msg.data);
				} else if (msg.type === "resize") {
					clientSizes.set(ws, { cols: msg.cols, rows: msg.rows });
					if (msg.mobile) mobileClients.add(ws);

					// Mobile resize always applies.
					// PC resize applies only when no mobile client is connected.
					if (msg.mobile) {
						resizePty(msg.cols, msg.rows);
					} else if (mobileClients.size === 0 && (activeWs === ws || activeWs === null)) {
						activeWs = ws;
						resizePty(msg.cols, msg.rows);
					}
				}
			} catch {
				// ignore malformed messages
			}
		});

		ws.on("close", () => {
			removeDataListener();
			removeExitListener();
			clientSizes.delete(ws);
			mobileClients.delete(ws);

			if (activeWs === ws) {
				activeWs = null;
				// Hand control to a remaining client
				const mSize = getMobileSize();
				if (mSize) {
					resizePty(mSize.cols, mSize.rows);
				} else {
					for (const [remainWs, size] of clientSizes) {
						if (remainWs.readyState === remainWs.OPEN) {
							activeWs = remainWs;
							resizePty(size.cols, size.rows);
							break;
						}
					}
				}
			}
		});
	});
}
