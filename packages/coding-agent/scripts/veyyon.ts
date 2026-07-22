/**
 * Bun `--preload` shim for the veyyon dev launcher (`scripts/veyyon`).
 *
 * The launcher starts Bun from an empty, bunfig-free directory so a foreign
 * project's `bunfig.toml` `preload` cannot run inside the veyyon CLI: Bun reads
 * `bunfig.toml` from the *current working directory* on startup and evaluates
 * its `preload` entries before the entrypoint, so a bun-shebang bin inherits
 * whatever `preload` the directory you launched from declares (and crashes if
 * that preload can't resolve). This shim is loaded before the entrypoint's
 * imports run, so it restores the user's real working directory in time for
 * import-time snapshots (e.g. `getProjectDir()` in `@veyyon/utils/dirs`).
 */
const launchCwd = process.env.VEYYON_LAUNCH_CWD;
if (launchCwd) {
	delete process.env.VEYYON_LAUNCH_CWD;
	try {
		process.chdir(launchCwd);
	} catch (error) {
		// Swallowing this used to leave the CLI running from the empty, bunfig-free
		// directory the launcher started it in. Every project-relative behaviour then
		// pointed at that empty directory: no project settings, no AGENTS.md, no git
		// repo, and file tools resolving relative paths against nothing. It looked
		// like veyyon could not see the user's files, with no hint as to why. There
		// is no safe way to continue, so say what happened and stop.
		process.stderr.write(
			`veyyon: cannot enter the directory it was launched from\n` +
				`  directory: ${launchCwd}\n` +
				`  error: ${error instanceof Error ? error.message : String(error)}\n` +
				`Run veyyon from a directory that still exists and that you can read.\n`,
		);
		process.exit(1);
	}
}
