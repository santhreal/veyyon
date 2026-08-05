/**
 * One ceiling for provider error detail that reaches an operator-visible message.
 *
 * A non-2xx body is not always the provider's error envelope. A corporate
 * proxy, a captive portal, a CDN interstitial or a misrouted gateway answers
 * with an HTML page, and every uncapped site interpolated the whole page into
 * `Error.message`. From there it becomes the assistant turn's `errorMessage`,
 * which is rendered in the TUI, written to the session file, and re-rendered on
 * every later read of that turn.
 *
 * This module imports nothing on purpose: the error classes, the providers and
 * the OAuth refreshers all need it, and several of them are already the leaves
 * that everything else imports.
 *
 * The caps that existed before this were per-site and disagreed: 4096 on the
 * OpenAI path, 1000 on Bedrock, 200 on the AWS SSO credential path, and nothing
 * at all on Anthropic, Devin, GitLab Duo, Codex and Google. 4096 is kept as the
 * shared value because it is the one that was already chosen for the busiest
 * path and is comfortably above any real provider envelope.
 */

/** Longest provider-supplied detail allowed into an `Error.message`. */
export const MAX_PROVIDER_ERROR_DETAIL_CHARS = 4096;

/**
 * Cap `detail` and say how much was dropped.
 *
 * The suffix is not decoration. Silent truncation and a genuinely short body
 * look identical, so an operator debugging a proxy cannot tell whether the
 * provider said little or the harness ate the rest. Naming the real size also
 * makes the total bounded rather than merely the field: the returned string is
 * never longer than the cap plus this suffix.
 */
export function boundProviderErrorDetail(detail: string): string {
	if (detail.length <= MAX_PROVIDER_ERROR_DETAIL_CHARS) return detail;
	return `${detail.slice(0, MAX_PROVIDER_ERROR_DETAIL_CHARS)} [truncated, ${detail.length} chars total]`;
}
