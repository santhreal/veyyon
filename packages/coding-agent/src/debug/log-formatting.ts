import { sanitizeText } from "@veyyon/utils";
import { replaceTabs, truncateToWidth, wrapTextWithAnsi } from "../tools/render-utils";

export function formatDebugLogLine(line: string, maxWidth: number): string {
	const sanitized = sanitizeText(line);
	const normalized = replaceTabs(sanitized);
	const width = Math.max(1, maxWidth);
	return truncateToWidth(normalized, width);
}

export function formatDebugLogExpandedLines(line: string, maxWidth: number): string[] {
	const sanitized = sanitizeText(line);
	const normalized = replaceTabs(sanitized);
	const width = Math.max(1, maxWidth);

	if (normalized.length === 0) {
		return [""];
	}

	return normalized.split("\n").flatMap(segment => wrapTextWithAnsi(segment, width));
}

export function parseDebugLogTimestampMs(line: string): number | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		if (!parsed || typeof parsed !== "object") {
			return undefined;
		}

		const timestamp = (parsed as { timestamp?: unknown }).timestamp;
		if (typeof timestamp !== "string") {
			return undefined;
		}

		const timestampMs = Date.parse(timestamp);
		return Number.isFinite(timestampMs) ? timestampMs : undefined;
	} catch {
		// Log lines are arbitrary text: a line that is not JSON, or JSON without a timestamp, has no time to
		// report and undefined says exactly that. The caller keeps the line and renders it without a
		// timestamp, so nothing is dropped for being unparseable.
		return undefined;
	}
}

export function parseDebugLogPid(line: string): number | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		if (!parsed || typeof parsed !== "object") {
			return undefined;
		}

		const pid = (parsed as { pid?: unknown }).pid;
		if (typeof pid !== "number") {
			return undefined;
		}

		return Number.isFinite(pid) ? pid : undefined;
	} catch {
		// Same as the timestamp reader above: no pid to report for a line that does not carry one, and the
		// line is still shown.
		return undefined;
	}
}
