import { Process } from "@veyyon/natives";
import * as logger from "./logger";
import { errorMessage } from "./type-guards";

let reportedUnavailable = false;

function reportUnavailable(error: unknown): void {
	if (reportedUnavailable) return;
	reportedUnavailable = true;
	logger.warn("Native process-tree operations are unavailable; process control is limited to direct children", {
		reason: errorMessage(error),
	});
}

export function processHandle(pid: number): Process | null {
	try {
		return Process.fromPid(pid) ?? null;
	} catch (error) {
		reportUnavailable(error);
		return null;
	}
}

export function processHandlesByPath(executablePath: string): Process[] {
	try {
		return Process.fromPath(executablePath);
	} catch (error) {
		reportUnavailable(error);
		return [];
	}
}
