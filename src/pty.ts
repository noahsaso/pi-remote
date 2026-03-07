/**
 * PTY management: spawn a process inside a pseudo-terminal and expose
 * data/exit listeners plus resize/write/kill controls.
 */

import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import type { IPty } from "node-pty";
import pty from "node-pty";

const require = createRequire(import.meta.url);

export interface PtyState {
	running: boolean;
	exitCode: number | null;
}

export type PtyDataListener = (data: string) => void;
export type PtyExitListener = (exitCode: number) => void;

const MAX_BUFFER = 200_000;

let ptyProcess: IPty | null = null;
let dataListeners: PtyDataListener[] = [];
let exitListeners: PtyExitListener[] = [];
let lastExitCode: number | null = null;
let outputBuffer = "";

function fixSpawnHelperPermissions(): void {
	try {
		// Resolve node-pty's actual location regardless of symlinks / monorepo layout
		const ptyPkg = require.resolve("node-pty/package.json");
		const ptyDir = dirname(ptyPkg);
		const os = platform();
		const cpu = arch();
		const helperPath = join(ptyDir, "prebuilds", `${os}-${cpu}`, "spawn-helper");
		const stat = statSync(helperPath);
		if (!(stat.mode & 0o111)) {
			chmodSync(helperPath, stat.mode | 0o755);
		}
	} catch {
		// spawn-helper may not exist on all platforms
	}
}

export interface SpawnOptions {
	/** Command to run inside the pty */
	command: string;
	/** Arguments for the command */
	args?: string[];
	/** Working directory */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Initial terminal columns (default: 120) */
	cols?: number;
	/** Initial terminal rows (default: 30) */
	rows?: number;
	/** If true, attach local stdin/stdout to the PTY (for local terminal interaction) */
	attachLocal?: boolean;
}

export async function spawnInPty(options: SpawnOptions): Promise<void> {
	if (ptyProcess) {
		throw new Error("PTY process already running");
	}

	fixSpawnHelperPermissions();

	lastExitCode = null;
	outputBuffer = "";

	ptyProcess = pty.spawn(options.command, options.args ?? [], {
		name: "xterm-256color",
		cols: options.cols ?? 120,
		rows: options.rows ?? 30,
		cwd: options.cwd ?? process.cwd(),
		env: options.env ?? (process.env as Record<string, string>),
	});

	ptyProcess!.onData((data: string) => {
		outputBuffer += data;
		if (outputBuffer.length > MAX_BUFFER) {
			outputBuffer = outputBuffer.slice(-MAX_BUFFER);
		}

		// Write to local stdout if attached
		if (options.attachLocal) {
			process.stdout.write(data);
		}

		// Broadcast to all WebSocket listeners
		for (const cb of dataListeners) {
			try {
				cb(data);
			} catch {
				// ignore listener errors
			}
		}
	});

	ptyProcess!.onExit(({ exitCode }: { exitCode: number }) => {
		lastExitCode = exitCode;
		ptyProcess = null;

		// Restore terminal if we attached local
		if (options.attachLocal && process.stdin.isTTY) {
			process.stdin.setRawMode(false);
			process.stdin.pause();
		}

		for (const cb of exitListeners) {
			try {
				cb(exitCode);
			} catch {
				// ignore listener errors
			}
		}
	});

	// Attach local stdin → PTY if requested
	if (options.attachLocal && process.stdin.isTTY) {
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("data", (data: Buffer) => {
			ptyProcess?.write(data.toString());
		});
	}
}

export function writeToPty(data: string): void {
	ptyProcess?.write(data);
}

export function resizePty(cols: number, rows: number): void {
	if (ptyProcess) {
		try {
			ptyProcess.resize(cols, rows);
		} catch {
			// ignore resize errors (process may be exiting)
		}
	}
}

export function killPty(): void {
	if (ptyProcess) {
		try {
			ptyProcess.kill();
		} catch {
			// ignore
		}
		ptyProcess = null;
	}
}

export function onPtyData(cb: PtyDataListener): () => void {
	dataListeners.push(cb);
	return () => {
		dataListeners = dataListeners.filter((l) => l !== cb);
	};
}

export function onPtyExit(cb: PtyExitListener): () => void {
	exitListeners.push(cb);
	return () => {
		exitListeners = exitListeners.filter((l) => l !== cb);
	};
}

export function getPtyState(): PtyState {
	return { running: !!ptyProcess, exitCode: lastExitCode };
}

export function getOutputBuffer(): string {
	return outputBuffer;
}
