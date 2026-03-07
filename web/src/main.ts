/**
 * App entry point.
 *
 * Desktop: full-screen terminal, resize button optional.
 * Mobile:  fixed-column terminal + virtual keybar + QR/URL info overlay.
 */

import QRCode from "qrcode";
import { isMobile, TerminalView, VIRTUAL_KEYS } from "./terminal.js";

// ─── Styles ──────────────────────────────────────────────────────────────────

const style = document.createElement("style");
style.textContent = `
  #app {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    background: #0a0a0a;
    color: #d4d4d4;
  }

  /* ── Top bar ─────────────────────────────────────────────────────────────── */
  #topbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    height: 40px;
    background: #141414;
    border-bottom: 1px solid #2a2a2a;
    flex-shrink: 0;
    font-size: 13px;
  }
  #topbar .title {
    font-weight: 600;
    letter-spacing: 0.05em;
    color: #e0e0e0;
    margin-right: auto;
  }
  #topbar button {
    background: none;
    border: 1px solid #3a3a3a;
    border-radius: 5px;
    color: #bbb;
    font-size: 12px;
    padding: 3px 10px;
    cursor: pointer;
  }
  #topbar button:hover { background: #2a2a2a; color: #fff; }

  /* ── Terminal wrapper ────────────────────────────────────────────────────── */
  #terminal-wrap {
    flex: 1;
    overflow: hidden;
    padding: 4px 8px;
  }
  #terminal-wrap .xterm { height: 100%; }

  /* ── Virtual keybar (mobile only) ───────────────────────────────────────── */
  #keybar {
    display: flex;
    gap: 4px;
    padding: 4px 8px;
    background: #141414;
    border-top: 1px solid #2a2a2a;
    flex-shrink: 0;
    height: 52px;
    align-items: center;
    overflow-x: auto;
  }
  #keybar button {
    background: #1e1e1e;
    border: 1px solid #3a3a3a;
    border-radius: 5px;
    color: #d4d4d4;
    font-size: 12px;
    padding: 4px 10px;
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
  }
  #keybar button:active { background: #2e2e2e; }

  /* ── Remote info overlay ─────────────────────────────────────────────────── */
  #remote-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  #remote-overlay.hidden { display: none; }
  #remote-card {
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 10px;
    padding: 24px 28px;
    max-width: 340px;
    width: 90%;
    text-align: center;
  }
  #remote-card h2 { margin-bottom: 6px; font-size: 16px; color: #e0e0e0; }
  #remote-card p  { font-size: 12px; color: #888; margin-bottom: 16px; }
  #qr-canvas { border-radius: 6px; margin-bottom: 14px; }
  #remote-url {
    background: #111;
    border: 1px solid #333;
    border-radius: 5px;
    padding: 6px 10px;
    font-size: 11px;
    word-break: break-all;
    color: #aaa;
    margin-bottom: 14px;
    text-align: left;
  }
  #overlay-buttons { display: flex; gap: 8px; justify-content: center; }
  #overlay-buttons button {
    background: #222;
    border: 1px solid #444;
    border-radius: 5px;
    color: #ccc;
    font-size: 12px;
    padding: 5px 14px;
    cursor: pointer;
  }
  #overlay-buttons button:hover { background: #2e2e2e; }
  #overlay-buttons button.primary { border-color: #555; color: #fff; background: #2a2a2a; }
`;
document.head.appendChild(style);

// ─── DOM ─────────────────────────────────────────────────────────────────────

const app = document.getElementById("app")!;

// Top bar
const topbar = document.createElement("div");
topbar.id = "topbar";
topbar.innerHTML = `<span class="title">π remote</span>`;

const remoteBtn = document.createElement("button");
remoteBtn.textContent = isMobile ? "Info" : "Remote link";
topbar.appendChild(remoteBtn);

app.appendChild(topbar);

// Terminal wrapper
const termWrap = document.createElement("div");
termWrap.id = "terminal-wrap";
app.appendChild(termWrap);

// Virtual keybar (mobile only)
let keybar: HTMLElement | null = null;
if (isMobile) {
	keybar = document.createElement("div");
	keybar.id = "keybar";
	app.appendChild(keybar);
}

// Remote info overlay
const overlay = document.createElement("div");
overlay.id = "remote-overlay";
overlay.classList.add("hidden");
overlay.innerHTML = `
  <div id="remote-card">
    <h2>Remote access</h2>
    <p>Scan with your phone or open the link on any device on the same network.</p>
    <canvas id="qr-canvas"></canvas>
    <div id="remote-url">Loading…</div>
    <div id="overlay-buttons">
      <button id="copy-btn">Copy link</button>
      <button class="primary" id="close-btn">Close</button>
    </div>
  </div>
`;
document.body.appendChild(overlay);

// ─── Terminal ─────────────────────────────────────────────────────────────────

const tv = new TerminalView(termWrap);

// ─── Virtual keybar buttons ───────────────────────────────────────────────────

if (keybar) {
	// Track touch start for distinguishing tap vs scroll
	let vkStartX = 0;
	let vkStartY = 0;
	let vkMoved = false;
	let vkTarget: HTMLElement | null = null;

	for (const key of VIRTUAL_KEYS) {
		const btn = document.createElement("button");
		btn.textContent = key.label;
		const seq = key.seq;

		btn.addEventListener("touchstart", (e) => {
			const touch = e.touches[0];
			vkStartX = touch.clientX;
			vkStartY = touch.clientY;
			vkMoved = false;
			vkTarget = btn;
			btn.style.background = "#2e2e2e";
		}, { passive: true });

		btn.addEventListener("touchmove", (e) => {
			if (vkMoved) return;
			const touch = e.touches[0];
			const dx = touch.clientX - vkStartX;
			const dy = touch.clientY - vkStartY;
			if (dx * dx + dy * dy > 64) vkMoved = true;
		}, { passive: true });

		btn.addEventListener("touchend", (e) => {
			e.preventDefault();
			vkTarget?.style.removeProperty("background");
			vkTarget = null;
			if (!vkMoved) tv.sendInput(seq);
		});

		keybar.appendChild(btn);
	}
}

// ─── Remote overlay ───────────────────────────────────────────────────────────

async function loadRemoteUrl(): Promise<void> {
	try {
		// Pass the current token along so the API call is authorised
		const token = new URLSearchParams(window.location.search).get("token");
		const tokenParam = token ? `?token=${token}` : "";
		const res = await fetch(`/api/local-url${tokenParam}`);
		const data = (await res.json()) as { url: string };
		const url = data.url;

		const urlEl = document.getElementById("remote-url")!;
		urlEl.textContent = url;

		const canvas = document.getElementById("qr-canvas") as HTMLCanvasElement;
		await QRCode.toCanvas(canvas, url, {
			width: 200,
			color: { dark: "#d9d9d9", light: "#141414" },
		});

		document.getElementById("copy-btn")!.addEventListener("click", () => {
			navigator.clipboard.writeText(url).catch(() => {});
		});
	} catch {
		const urlEl = document.getElementById("remote-url");
		if (urlEl) urlEl.textContent = "Failed to load remote URL";
	}
}

remoteBtn.addEventListener("click", () => {
	overlay.classList.remove("hidden");
	loadRemoteUrl();
});

document.getElementById("close-btn")?.addEventListener("click", () => {
	overlay.classList.add("hidden");
});

// On desktop, show the overlay on first load so the user knows the remote URL
if (!isMobile) {
	overlay.classList.remove("hidden");
	loadRemoteUrl();
}
