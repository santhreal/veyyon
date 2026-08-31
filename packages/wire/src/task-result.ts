/**
 * The `<task-result>` envelope a finished subagent returns, and how to read a human
 * preview out of it.
 *
 * The envelope is written by `packages/coding-agent/src/prompts/tools/task-summary.md`
 * and exists for the MODEL: the parent agent parses the status, the duration and the
 * `agent://` pointer out of it. A person reading a job row wants none of that markup,
 * only the body.
 *
 * It lives here because two packages read it and neither owns it. The TUI's job tool
 * (`packages/coding-agent/src/tools/job.ts`) and the shared React renderer that draws
 * the same rows for HTML export and collab-web (`packages/tool-render/src/tools/job.tsx`)
 * each carried a byte-identical copy of the parser. Two copies of one wire shape drift
 * in one direction only: the surface nobody was looking at keeps the old pattern, fails
 * to match, and shows the reader raw envelope markup while the other surface stays clean.
 * `@veyyon/wire` is dependency-free and both already depend on it, so it costs no new edge.
 */

/**
 * The inner `<output>`/`<preview>` body of a `<task-result>` envelope, trimmed.
 *
 * Returns the input unchanged when it is not an envelope, or when the envelope carries
 * no body to show: a preview that says nothing is worse than the markup it replaced.
 */
export function stripTaskResultEnvelope(text: string): string {
	if (!text.startsWith("<task-result")) return text;
	const body = /<(output|preview)(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/\1>/.exec(text)?.[2];
	return body?.trim() || text;
}
