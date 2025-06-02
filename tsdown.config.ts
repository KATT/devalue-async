import { defineConfig } from "tsdown";

// eslint-disable-next-line @typescript-eslint/no-unsafe-call
export default defineConfig({
	// Clean output directory before building
	clean: true,
	// Generate TypeScript declaration files
	dts: true,
	// Generate sourcemaps
	sourcemap: true,
	// Entry points - all TypeScript files except tests
	entry: ["src/**/*.ts", "!src/**/*.test.*", "!src/**/test.*"],
	// Output format
	format: "esm",
	// Output directory
	outDir: "lib",
});
