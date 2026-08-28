export function truncateForLog(value: string, maxLen: number): string {
	return value.length > maxLen ? `${value.slice(0, maxLen)}...[truncated]` : value;
}
