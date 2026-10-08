/**
 * Preload for a CLI a test launches: on SIGUSR2 it writes the path of every module the process has
 * evaluated (`require.cache`, which holds ES modules too) to the file `LOADED_MODULE_CENSUS` names, one
 * per line, then exits. A compiled binary does not expose the cache, so this runs against source.
 */
import * as fs from "node:fs";

const out = process.env.LOADED_MODULE_CENSUS;
if (out) {
	process.on("SIGUSR2", () => {
		fs.writeFileSync(out, Object.keys(require.cache).join("\n"));
		process.exit(0);
	});
}
