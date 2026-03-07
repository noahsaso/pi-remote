/**
 * Terminal: xterm.js instance wired to the WebSocket PTY bridge.
 *
 * Mobile-specific handling:
 *  - Fixed 60-column layout with auto font-size scaling
 *  - Touch scroll with inertia via terminal.scrollLines()
 *  - Virtual keybar for common escape sequences
 *  - Mobile flag sent in resize messages so server preserves mobile sizing
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

export const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

// Virtual keys shown on mobile: label → escape sequence
export const VIRTUAL_KEYS = [
	{ label: "↑", seq: "\x1b[A" },
	{ label: "↓", seq: "\x1b[B" },
	{ label: "←", seq: "\x1b[D" },
	{ label: "→", seq: "\x1b[C" },
	{ label: "Enter", seq: "\r" },
	{ label: "Tab", seq: "\t" },
	{ label: "Esc", seq: "\x1b" },
	{ label: "Ctrl+C", seq: "\x03" },
] as const;

type BrowserMessage =
	| { type: "input"; data: string }
	| { type: "resize"; cols: number; rows: number; mobile?: boolean };

type ServerMessage =
	| { type: "data"; data: string }
	| { type: "exit"; exitCode: number | null }
	| { type: "state"; running: boolean; exitCode: number | null };

export class TerminalView {
	private terminal: Terminal;
	private fitAddon: FitAddon;
	private webglAddon: WebglAddon | null = null;
	private ws: WebSocket | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private container: HTMLElement;

	// Write throttle
	private writeBuffer = "";
	private writeTimer: number | null = null;

	// Mobile touch scroll state
	private stopMobileMomentum: (() => void) | null = null;

	constructor(container: HTMLElement) {
		this.container = container;
		this.terminal = new Terminal({
			cursorBlink: !isMobile,
			fontSize: isMobile ? 11 : 13,
			fontFamily: 'Menlo, Monaco, "Courier New", monospace',
			theme: {
				background: "#0a0a0a",
				foreground: "#d4d4d4",
				cursor: "#d4d4d4",
				selectionBackground: "#264f78",
			},
			allowProposedApi: true,
			scrollback: isMobile ? 500 : 1000,
		});

		this.fitAddon = new FitAddon();
		this.terminal.loadAddon(this.fitAddon);
		this.terminal.open(container);

		// GPU-accelerated rendering, fallback to canvas on failure
		try {
			this.webglAddon = new WebglAddon();
			this.webglAddon.onContextLoss(() => {
				this.webglAddon?.dispose();
				this.webglAddon = null;
			});
			this.terminal.loadAddon(this.webglAddon);
		} catch {
			this.webglAddon = null;
		}

		// Forward keyboard input to server
		this.terminal.onData((data) => {
			this.sendInput(data);
		});

		if (isMobile) {
			requestAnimationFrame(() => this.mobileFixedResize());
			this.setupMobileTouchScroll();
		} else {
			requestAnimationFrame(() => {
				this.fitAddon.fit();
				this.terminal.focus();
			});
			this.setupResizeObserver();
		}

		this.connect();
	}

	// -------------------------------------------------------------------------
	// WebSocket
	// -------------------------------------------------------------------------

	private connect(): void {
		const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
		// Preserve ?token= query param for authentication
		const token = new URLSearchParams(window.location.search).get("token");
		const tokenParam = token ? `?token=${token}` : "";
		const wsUrl = `${proto}//${window.location.host}/ws/terminal${tokenParam}`;

		this.ws = new WebSocket(wsUrl);

		this.ws.onmessage = (event) => {
			try {
				const msg = JSON.parse(event.data as string) as ServerMessage;
				if (msg.type === "data") {
					this.throttledWrite(msg.data);
				} else if (msg.type === "exit") {
					this.flushWrite();
					const code = msg.exitCode ?? "?";
					this.terminal.write(`\r\n\x1b[33mProcess exited (code ${code})\x1b[0m\r\n`);
				} else if (msg.type === "state") {
					if (!msg.running && msg.exitCode !== null) {
						this.flushWrite();
						this.terminal.write(`\x1b[33mProcess exited (code ${msg.exitCode})\x1b[0m\r\n`);
					}
				}
			} catch {
				// ignore parse errors
			}
		};

		this.ws.onclose = () => {
			// Auto-reconnect after 2s
			setTimeout(() => {
				if (this.container.isConnected) this.connect();
			}, 2000);
		};

		this.ws.onopen = () => {
			this.sendResize();
		};
	}

	private send(msg: BrowserMessage): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	sendInput(data: string): void {
		this.send({ type: "input", data });
	}

	sendResize(): void {
		if (!this.terminal) return;
		const msg: BrowserMessage & { type: "resize" } = {
			type: "resize",
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		};
		if (isMobile) msg.mobile = true;
		this.send(msg);
	}

	// -------------------------------------------------------------------------
	// Write throttle
	// -------------------------------------------------------------------------

	private throttledWrite(data: string): void {
		this.writeBuffer += data;
		if (!this.writeTimer) {
			this.writeTimer = requestAnimationFrame(() => this.flushWrite());
		}
	}

	private flushWrite(): void {
		if (this.writeTimer !== null) {
			cancelAnimationFrame(this.writeTimer);
			this.writeTimer = null;
		}
		if (this.writeBuffer && this.terminal) {
			this.terminal.write(this.writeBuffer);
			this.writeBuffer = "";
		}
	}

	// -------------------------------------------------------------------------
	// Resize
	// -------------------------------------------------------------------------

	private setupResizeObserver(): void {
		this.resizeObserver = new ResizeObserver(() => {
			try {
				this.fitAddon.fit();
				this.sendResize();
			} catch {
				// ignore
			}
		});
		this.resizeObserver.observe(this.container);
	}

	/**
	 * Mobile: fix to 60 columns and scale font-size to fill the screen width,
	 * then calculate rows from available height. This avoids resize jitter.
	 */
	private mobileFixedResize(): void {
		const cellDims = (this.terminal as any)._core?._renderService?.dimensions?.css?.cell;
		if (!cellDims?.width || !cellDims?.height) {
			setTimeout(() => this.mobileFixedResize(), 50);
			return;
		}

		const MOBILE_COLS = 60;
		const padX = 16;
		const padY = 8;
		const topBarHeight = 40;
		const keybarHeight = isMobile ? 52 : 0;

		const availableWidth = window.innerWidth - padX;
		const availableHeight = window.innerHeight - topBarHeight - keybarHeight - padY;

		const currentFontSize = this.terminal.options.fontSize ?? 11;
		const targetFontSize =
			Math.floor((currentFontSize * availableWidth) / (MOBILE_COLS * cellDims.width) * 10) / 10;

		this.terminal.options.fontSize = targetFontSize;

		requestAnimationFrame(() => {
			const newDims = (this.terminal as any)._core?._renderService?.dimensions?.css?.cell;
			const lineHeight = newDims?.height ?? cellDims.height;
			const rows = Math.max(5, Math.min(Math.floor(availableHeight / lineHeight), 100));
			this.terminal.resize(MOBILE_COLS, rows);
			this.sendResize();
		});
	}

	// -------------------------------------------------------------------------
	// Mobile touch scroll (ported from cc-viewer/TerminalPanel.jsx)
	// -------------------------------------------------------------------------

	private setupMobileTouchScroll(): void {
		const screen = this.container.querySelector(".xterm-screen") as HTMLElement | null;
		if (!screen) return;

		const term = this.terminal;
		const getLineHeight = (): number => {
			const cellDims = (term as any)._core?._renderService?.dimensions?.css?.cell;
			return cellDims?.height ?? 15;
		};

		let lastY = 0;
		let lastTime = 0;
		let momentumRaf: number | null = null;
		let pixelAccum = 0;
		let pendingDy = 0;
		let scrollRaf: number | null = null;
		let velocitySamples: Array<{ v: number; t: number }> = [];

		const stopMomentum = (): void => {
			if (momentumRaf !== null) { cancelAnimationFrame(momentumRaf); momentumRaf = null; }
			if (scrollRaf !== null) { cancelAnimationFrame(scrollRaf); scrollRaf = null; }
			pendingDy = 0;
			pixelAccum = 0;
		};
		this.stopMobileMomentum = stopMomentum;

		const flushScroll = (): void => {
			scrollRaf = null;
			if (pendingDy === 0) return;
			pixelAccum += pendingDy;
			pendingDy = 0;
			const lh = getLineHeight();
			const lines = Math.trunc(pixelAccum / lh);
			if (lines !== 0) {
				term.scrollLines(lines);
				pixelAccum -= lines * lh;
			}
		};

		screen.addEventListener("touchstart", (e) => {
			stopMomentum();
			if (e.touches.length !== 1) return;
			lastY = e.touches[0].clientY;
			lastTime = performance.now();
			velocitySamples = [];
		}, { passive: true });

		screen.addEventListener("touchmove", (e) => {
			if (e.touches.length !== 1) return;
			const y = e.touches[0].clientY;
			const now = performance.now();
			const dt = now - lastTime;
			const dy = lastY - y;

			if (dt > 0) {
				const v = (dy / dt) * 16;
				velocitySamples.push({ v, t: now });
				while (velocitySamples.length > 0 && now - velocitySamples[0].t > 100) {
					velocitySamples.shift();
				}
			}

			pendingDy += dy;
			if (scrollRaf === null) scrollRaf = requestAnimationFrame(flushScroll);
			lastY = y;
			lastTime = now;
		}, { passive: true });

		screen.addEventListener("touchend", () => {
			if (scrollRaf !== null) { cancelAnimationFrame(scrollRaf); scrollRaf = null; }
			if (pendingDy !== 0) {
				pixelAccum += pendingDy;
				pendingDy = 0;
				const lh = getLineHeight();
				const lines = Math.trunc(pixelAccum / lh);
				if (lines !== 0) term.scrollLines(lines);
				pixelAccum = 0;
			}

			// Inertia
			let velocity = 0;
			if (velocitySamples.length >= 2) {
				let totalWeight = 0;
				let weightedV = 0;
				const latest = velocitySamples[velocitySamples.length - 1].t;
				for (const s of velocitySamples) {
					const w = Math.max(0, 1 - (latest - s.t) / 100);
					weightedV += s.v * w;
					totalWeight += w;
				}
				velocity = totalWeight > 0 ? weightedV / totalWeight : 0;
			}
			velocitySamples = [];

			if (Math.abs(velocity) < 0.5) return;
			const friction = 0.95;
			let mAccum = 0;
			const tick = (): void => {
				if (Math.abs(velocity) < 0.3) {
					const lh = getLineHeight();
					const rest = Math.round(mAccum / lh);
					if (rest !== 0) term.scrollLines(rest);
					momentumRaf = null;
					return;
				}
				mAccum += velocity;
				const lh = getLineHeight();
				const lines = Math.trunc(mAccum / lh);
				if (lines !== 0) { term.scrollLines(lines); mAccum -= lines * lh; }
				velocity *= friction;
				momentumRaf = requestAnimationFrame(tick);
			};
			momentumRaf = requestAnimationFrame(tick);
		}, { passive: true });
	}

	// -------------------------------------------------------------------------
	// Cleanup
	// -------------------------------------------------------------------------

	dispose(): void {
		this.stopMobileMomentum?.();
		if (this.writeTimer !== null) cancelAnimationFrame(this.writeTimer);
		this.ws?.close();
		this.resizeObserver?.disconnect();
		this.webglAddon?.dispose();
		this.terminal.dispose();
	}
}
