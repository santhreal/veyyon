/**
 * A debug session as the lines a reader is shown.
 *
 * Separate from the debug tool because both halves of that tool need it: the tool writes these lines
 * into its own text result, and the card describes them to a host. Leaving it in `debug.ts` made the
 * card's view import the tool it belongs to, which is a cycle, so the formatter sits where neither
 * half owns it and both can reach it.
 */

import type { DapSessionSummary } from "./dap";

/** Where the session is stopped, as `path:line[:column]`, or nothing when it is not stopped in source. */
export function formatLocation(snapshot: DapSessionSummary | undefined): string | null {
	if (!snapshot?.source?.path || snapshot.line === undefined) {
		return null;
	}
	return `${snapshot.source.path}:${snapshot.line}${snapshot.column !== undefined ? `:${snapshot.column}` : ""}`;
}

export function formatSessionSnapshot(snapshot: DapSessionSummary): string[] {
	const lines = [
		`Session ${snapshot.id}`,
		`Adapter: ${snapshot.adapter}`,
		`Status: ${snapshot.status}`,
		`CWD: ${snapshot.cwd}`,
	];
	if (snapshot.program) lines.push(`Program: ${snapshot.program}`);
	if (snapshot.stopReason) lines.push(`Stop reason: ${snapshot.stopReason}`);
	if (snapshot.frameName) lines.push(`Frame: ${snapshot.frameName}`);
	if (snapshot.instructionPointerReference) {
		lines.push(`Instruction pointer: ${snapshot.instructionPointerReference}`);
	}
	const location = formatLocation(snapshot);
	if (location) lines.push(`Location: ${location}`);
	if (snapshot.needsConfigurationDone) {
		lines.push("Configuration: pending configurationDone; set breakpoints, then continue.");
	}
	if (snapshot.exitCode !== undefined) lines.push(`Exit code: ${snapshot.exitCode}`);
	return lines;
}
