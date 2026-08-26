import { Process } from "@veyyon/natives";
import * as logger from "./logger";
import { errorMessage } from "./type-guards";

/**
 * Process-tree handles that degrade instead of throwing.
 *
 * `Process` is a lazy native export: the first property access loads the addon
 * and throws when no candidate loads. A container whose glibc predates the
 * modern build is one such host. Teardown code called `Process.fromPid` inside
 * a cleanup callback, so that throw ended the process instead of the child it
 * was cancelling (issue #917); the `?.catch()` after the call handles a
 * rejected promise and never the throw from the property access itself.
 *
 * Only the tree walk requires the addon. Each caller already has a
 * runtime-level equivalent for a single process — `Subprocess.kill`,
 * `process.kill`, `isProcessAlive` — so a `null` handle lets the caller apply
 * the degradation that is correct for it, and records in one place that
 * descendants are no longer reached.
 */

let reportedUnavailable = false;

function reportUnavailable(error: unknown): void {
	if (reportedUnavailable) return;
	reportedUnavailable = true;
	logger.warn("Native process-tree operations are unavailable; process control is limited to direct children", {
		reason: errorMessage(error),
	});
}

/** A native handle for `pid`, or `null` when the pid is gone or the addon cannot load. */
export function processHandle(pid: number): Process | null {
	try {
		return Process.fromPid(pid) ?? null;
	} catch (error) {
		reportUnavailable(error);
		return null;
	}
}

/** Native handles for every process running `executablePath`, empty when the addon cannot load. */
export function processHandlesByPath(executablePath: string): Process[] {
	try {
		return Process.fromPath(executablePath);
	} catch (error) {
		reportUnavailable(error);
		return [];
	}
}
