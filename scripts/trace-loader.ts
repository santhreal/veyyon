/**
 * Traces module resolution, to find what a slow import is actually loading.
 *
 * A Bun preload that hooks `onResolve` and prints every path the first time it
 * is resolved, with the elapsed time since startup. Use it when a script or a
 * suite takes longer to START than to run: the output shows which import pulled
 * in a barrel, and the timestamps show where the cliff is. It does not
 * interfere with loading, so the traced program behaves normally.
 *
 * Usage:
 *   bun --preload ./scripts/trace-loader.ts <script>
 */

const startTime = Bun.nanoseconds();
const resolved = new Set<string>();

Bun.plugin({
	name: "trace-loader",
	setup(build) {
		// Trace module resolution (doesn't interfere with loading)
		build.onResolve({ filter: /.*/ }, args => {
			// Skip if already traced this path
			if (resolved.has(args.path)) {
				return undefined;
			}
			resolved.add(args.path);

			const elapsed = ((Bun.nanoseconds() - startTime) / 1e6).toFixed(1);
			// Only trace local/project files, not node_modules
			if (!args.path.includes("node_modules") && !args.path.startsWith("node:")) {
				const shortPath = args.path.replace(process.cwd(), ".");
				process.stderr.write(`[${elapsed}ms] resolve: ${shortPath}\n`);
			}

			// Return undefined to let Bun handle resolution normally
			return undefined;
		});
	},
});

process.stderr.write(`[trace-loader] preload active\n`);
