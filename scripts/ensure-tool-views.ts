import * as nodeFs from "node:fs";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");

/** The gitignored bundle, named once so every caller and every message agrees. */
export const TOOL_VIEWS_GENERATED = path.join(repoRoot, "packages/coding-agent/src/export/html/tool-views.generated.js");

/** The command that produces it, named once for the same reason. */
export const GENERATE_TOOL_VIEWS_COMMAND = "bun --cwd=packages/collab-web run gen:tool-views";

/**
 * Ensure the generated tool-views bundle exists before any TS suite runs.
 *
 * `packages/coding-agent/src/export/html/index.ts` imports
 * `./tool-views.generated.js` with `{ type: "text" }`, which resolves at module
 * PARSE time, and the file is gitignored build output. A clone or archive of
 * HEAD therefore fails three suites with "Cannot find module" before a single
 * assertion runs, and the failure names a missing file rather than a missing
 * build step. bun runs no root lifecycle script on `bun install` (neither
 * `prepare` nor `postinstall`), so there is nowhere in install to hang this.
 *
 * It has to be reachable from two entry points, which is why it lives here
 * rather than inside the test runner. `bun run test` goes through
 * `scripts/ci-test-ts.ts`, but the shortcut a developer actually types is a bare
 * `bun test` from inside a package, and bun runs no `pre`/`post` script for
 * that. The second entry point is the `bunfig.toml` preload, which is the one
 * hook a bare `bun test` does honour.
 *
 * Regenerating happens only when the file is absent, so a normal run pays a
 * single `existsSync`.
 */
export async function ensureToolViewsGenerated(): Promise<void> {
	if (nodeFs.existsSync(TOOL_VIEWS_GENERATED)) return;
	process.stdout.write("generating tool-views.generated.js (missing build artifact)\n");
	const proc = Bun.spawn(["bun", "--cwd=packages/collab-web", "run", "gen:tool-views"], {
		cwd: repoRoot,
		stdout: "inherit",
		stderr: "inherit",
	});
	const code = await proc.exited;
	// Fail closed and name the fix: continuing here means every suite that
	// imports the bundle dies with a module-resolution error instead.
	if (code !== 0) {
		throw new Error(
			`could not generate ${TOOL_VIEWS_GENERATED} (exit ${code}). ` +
				`Run \`${GENERATE_TOOL_VIEWS_COMMAND}\` and check that install completed.`,
		);
	}
}
