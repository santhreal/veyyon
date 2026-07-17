/**
 * Estimate LLM tokens for a text chunk: UTF-8 bytes / 4, rounded up.
 *
 * Byte-based (not char-based) so multibyte text — which tokenizes into more
 * tokens, not fewer — is never underestimated. This is the ONE cheap text
 * estimator; packages needing tokenizer-grade accuracy layer it behind a real
 * counter (see @veyyon/pi-agent-core countTokens). Message-level estimation
 * (AgentMessage) is a different function and lives with compaction.
 */
export function estimateTextTokens(text: string): number {
	return (Buffer.byteLength(text, "utf-8") + 3) >> 2;
}
