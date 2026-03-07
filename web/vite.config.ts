import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
	root: ".",
	build: {
		outDir: "../web-dist",
		emptyOutDir: true,
	},
	server: {
		proxy: {
			"/ws/terminal": {
				target: "ws://127.0.0.1:7009",
				ws: true,
			},
			"/api": {
				target: "http://127.0.0.1:7009",
			},
		},
	},
});
