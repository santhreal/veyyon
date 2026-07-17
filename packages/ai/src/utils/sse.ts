/** Format one server-sent event frame with a JSON payload. */
export function sseEvent(event: string, body: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(body)}\n\n`;
}
