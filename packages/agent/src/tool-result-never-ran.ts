/** The one rule for "this tool result is a placeholder, nothing happened". */
export function toolResultNeverRan(details: unknown): boolean {
	if (details == null || typeof details !== "object") return false;
	const record = details as Record<string, unknown>;
	if (record.__skipped === true) return record.entered !== true;
	return record.__synthetic === true && record.executed === false;
}
