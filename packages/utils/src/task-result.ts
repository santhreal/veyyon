/**
 * Task job results are delivered in the model-facing `<task-result>` envelope
 * (prompts/tools/task-summary.md) so the parent agent can parse status and the
 * `agent://` pointer. ONE PLACE for the envelope grammar: the CLI job tool and
 * the browser job card must strip it identically, so the parser lives here.
 * Dependency-free — safe for browser bundles via the `task-result` subpath.
 */

const ENVELOPE_BODY_RE = /<(output|preview)(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/\1>/;

/** Human preview of a task result: the inner <output>/<preview> body. */
export function stripTaskResultEnvelope(text: string): string {
	if (!text.startsWith("<task-result")) return text;
	const body = ENVELOPE_BODY_RE.exec(text)?.[2];
	return body?.trim() || text;
}
