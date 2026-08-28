/** Task-result envelope utilities. */
/** Inner `<output>`/`<preview>` body of a `<task-result>` envelope, trimmed. */
export function stripTaskResultEnvelope(text: string): string {
	if (!text.startsWith("<task-result")) return text;
	const body = /<(output|preview)(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/\1>/.exec(text)?.[2];
	return body?.trim() || text;
}
