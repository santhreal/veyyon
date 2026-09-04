import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";

/**
 * Default hard ceiling for a single web round-trip. 60s tolerates
 * legitimate slow LLM-mediated responses (anthropic web_search_20250305,
 * perplexity, gemini, codex) while still guaranteeing the session unfreezes
 * within a minute if Bun's `AbortSignal` fails to propagate on Windows.
 *
 * Pure search APIs (brave, exa, jina, tavily, searxng, synthetic, zai)
 * settle far faster in practice; reusing the same ceiling keeps the wiring
 * uniform without compromising correctness.
 */
export const SEARCH_HARD_TIMEOUT_MS = 60_000;

/**
 * Run a provider request under a caller signal composed with a hard timeout,
 * so the outbound `fetch()` (and the body read after it) is guaranteed to
 * settle within `ms` even when the runtime fails to propagate cancellation to
 * the underlying transport. The backing timer is cleared the moment `fn`
 * settles, so no armed timeout outlives the request.
 *
 * Bun's WinHTTP backend on Windows is known to ignore `AbortSignal` once a
 * TCP/TLS connection stalls (oven-sh/bun#15275, oven-sh/bun#18536); without
 * this safety net a stalled web-search request freezes the entire session
 * because the user's Esc is never delivered to the native layer.
 *
 * @param signal - Caller cancellation signal, if any.
 * @param ms - Hard timeout in milliseconds. Defaults to {@link SEARCH_HARD_TIMEOUT_MS}.
 */
export async function withHardTimeout<T>(
	signal: AbortSignal | undefined,
	fn: (signal: AbortSignal) => Promise<T>,
	ms: number = SEARCH_HARD_TIMEOUT_MS,
): Promise<T> {
	const timeout = scopedTimeoutSignal(ms, signal);
	try {
		return await fn(timeout.signal);
	} finally {
		timeout.cancel();
	}
}
