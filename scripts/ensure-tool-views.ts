import * as path from "node:path";
import { TOOL_VIEWS_OUT_FILE, toolViewsStaleness, writeToolViewsBundle } from "../clients/web/scripts/build-tool-views";

/** The command that produces the bundle, named in the failure message. */
const GENERATE_TOOL_VIEWS_COMMAND = "bun --cwd=clients/web run gen:tool-views";

/**
 * Ensure the generated tool-views bundle exists and was built from the current sources before any
 * TS suite runs.
 *
 * `packages/coding-agent/src/export/html/index.ts` imports
 * `./tool-views.generated.js` with `{ type: "text" }`, which resolves at module
 * PARSE time, and the file is gitignored build output. A clone or archive of
 * HEAD therefore fails three suites with "Cannot find module" before a single
 * assertion runs, and the failure names a missing file rather than a missing
 * build step. bun runs no root lifecycle script on `bun install` (neither
 * `prepare` nor `postinstall`), so there is nowhere in install to hang this.
 *
 * A bundle that exists but predates its sources is as broken as a missing one, only later: the
 * export viewer calls a global the old bundle never published (`formatToolCallLabel`), and the
 * exported tree throws a ReferenceError in the browser. The bundle carries a hash of every file it
 * was built from, so a changed, added or removed input is detected here and rebuilt.
 *
 * It has to be reachable from two entry points, which is why it lives here
 * rather than inside the test runner. `bun run test` goes through
 * `scripts/ci-test-ts.ts`, but the shortcut a developer actually types is a bare
 * `bun test` from inside a package, and bun runs no `pre`/`post` script for
 * that. The second entry point is the `bunfig.toml` preload, which is the one
 * hook a bare `bun test` does honour.
 *
 * A current bundle costs one read of it and one of each input it lists; nothing is built.
 */
export async function ensureToolViewsGenerated(outFile: string = TOOL_VIEWS_OUT_FILE): Promise<void> {
	const staleness = await toolViewsStaleness(outFile);
	if (staleness === null) return;
	process.stdout.write(`generating ${path.basename(outFile)} (${staleness})\n`);
	try {
		await writeToolViewsBundle(outFile);
	} catch (error) {
		// Fail closed and name the fix: continuing here means every suite that
		// imports the bundle dies with a module-resolution error, or an export
		// test runs against a viewer the sources no longer describe.
		throw new Error(
			`could not generate ${outFile}: ${error instanceof Error ? error.message : String(error)}. ` +
				`Run \`${GENERATE_TOOL_VIEWS_COMMAND}\` and check that install completed.`,
			{ cause: error },
		);
	}
}
