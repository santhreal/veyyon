import { ensureChromiumExecutable } from "@veyyon/coding-agent/tools/web/browser/launch";

/**
 * Whether the Chromium puppeteer resolves can execute on this host. CI runners without Chrome's
 * system libraries (libnspr4 & co.) hold the downloaded binary but cannot exec it, so a real-browser
 * suite probes with `--version` and skips instead of failing.
 */
export async function chromiumCanLaunch(): Promise<boolean> {
	try {
		const executable = await ensureChromiumExecutable();
		if (!executable) return false;
		return Bun.spawnSync([executable, "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
	} catch {
		return false;
	}
}
