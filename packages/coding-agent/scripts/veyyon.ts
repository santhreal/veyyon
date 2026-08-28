const launchCwd = process.env.VEYYON_LAUNCH_CWD;
if (launchCwd) {
	delete process.env.VEYYON_LAUNCH_CWD;
	try {
		process.chdir(launchCwd);
	} catch (error) {
		process.stderr.write(
			`veyyon: cannot enter the directory it was launched from\n` +
				`  directory: ${launchCwd}\n` +
				`  error: ${error instanceof Error ? error.message : String(error)}\n` +
				`Run veyyon from a directory that still exists and that you can read.\n`,
		);
		process.exit(1);
	}
}
