#!/usr/bin/env node
/**
 * pi-remote CLI entry point.
 *
 * Usage:
 *   pi-remote [-- <pi-args...>]
 *   pi-remote --pi-path /custom/pi [-- <pi-args...>]
 */

import { startRemote } from "./index.js";

const argv = process.argv.slice(2);

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
