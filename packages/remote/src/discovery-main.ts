#!/usr/bin/env node
/**
 * Entry point for the detached discovery service process.
 * Spawned by the first pi-remote session; exits when the last session deregisters.
 */
import { startDiscoveryService } from "./discovery.js";

startDiscoveryService().catch((err) => {
	process.stderr.write(`[discovery] failed to start: ${err}\n`);
	process.exit(1);
});
