#!/usr/bin/env node
/**
 * pi-remote CLI entry point.
 *
 * Usage:
 *   pi-remote [-- <pi-args...>]
 *   pi-remote --pi-path /custom/pi [-- <pi-args...>]
 *   pi-remote --discovery          # run only the persistent discovery service
 */

import { startRemote } from "./index.js";

const argv = process.argv.slice(2);

// Parse --discovery (run persistent discovery service only)
const discoveryIdx = argv.indexOf("--discovery");
if (discoveryIdx !== -1) {
	argv.splice(discoveryIdx, 1);
	const { startDiscoveryService } = await import("./discovery.js");
	await startDiscoveryService(true);
	// Keep the process alive — startDiscoveryService resolves after the server starts listening
	// The process stays alive because the HTTP server holds the event loop open
} else {
	let piPath: string | undefined;
	let extraArgs: string[] = [];

	// Parse --pi-path <path>
	const piPathIdx = argv.indexOf("--pi-path");
	if (piPathIdx !== -1 && piPathIdx + 1 < argv.length) {
		piPath = argv[piPathIdx + 1];
		argv.splice(piPathIdx, 2);
	}

	// Everything after -- is forwarded to pi
	const dashDash = argv.indexOf("--");
	if (dashDash !== -1) {
		extraArgs = argv.slice(dashDash + 1);
	}

	startRemote({ piPath, args: extraArgs }).catch((err) => {
		process.stderr.write(`pi-remote: ${(err as Error).message}\n`);
		process.exit(1);
	});
}
