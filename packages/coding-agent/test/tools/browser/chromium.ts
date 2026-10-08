import { ensureChromiumExecutable } from "@veyyon/coding-agent/tools/web/browser/launch";

/**
 * Whether the Chromium puppeteer resolves can execute on this host. CI runners without Chrome's
 * system libraries (libnspr4 and others) hold the downloaded binary but cannot exec it, so the
 * binary is probed with --version and suites that launch it skip instead of failing.
 */
async function chromiumCanLaunch(): Promise<boolean> {
	try {
		const executable = await ensureChromiumExecutable();
		if (!executable) return false;
		const probe = Bun.spawnSync([executable, "--version"], { stdout: "ignore", stderr: "ignore" });
		return probe.exitCode === 0;
	} catch {
		return false;
	}
}

export const CHROMIUM_AVAILABLE = await chromiumCanLaunch();
