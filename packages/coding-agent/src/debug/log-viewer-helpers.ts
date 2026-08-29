import { sanitizeText } from "@veyyon/utils";

export const SESSION_BOUNDARY_WARNING = "### WARNING - Logs above are older than current session!";
export const LOAD_OLDER_LABEL = "### MOVE UP TO LOAD MORE...";

export const INITIAL_LOG_CHUNK = 50;
export const LOAD_OLDER_CHUNK = 50;
export const MIN_LOG_VIEWER_WIDTH = 48;
export const LOG_VIEWER_CHROME_LINES = 8;

export type LogEntry = {
	rawLine: string;
	timestampMs: number | undefined;
	pid: number | undefined;
};

export type CursorToken = { kind: "log"; logIndex: number } | { kind: "load-older" };

export type DebugLogViewerModelOptions = {
	processStartMs?: number;
	processPid?: number;
	hasOlderLogs?: () => boolean;
	loadOlderLogs?: (limitDays?: number) => Promise<string>;
};

export type ViewerRow =
	| {
			kind: "warning";
	  }
	| {
			kind: "load-older";
	  }
	| {
			kind: "log";
			logIndex: number;
	  };

export function getProcessStartMs(): number {
	return Date.now() - process.uptime() * 1000;
}

export function splitLogText(logText: string): string[] {
	return logText.split("\n").filter(line => line.length > 0);
}

export function buildLogCopyPayload(lines: string[]): string {
	return lines
		.map(line => sanitizeText(line))
		.filter(line => line.length > 0)
		.join("\n");
}
